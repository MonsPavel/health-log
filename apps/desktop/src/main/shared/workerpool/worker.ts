/**
 * TASK-066 §5/§6: точка входа воркера пула (2 потока, worker_threads) — реестр
 * задач (Map name→fn) и цикл обмена по протоколу §7 (protocol.ts).
 *
 * КАК ЗАДАЧИ ПОПАДАЮТ В ВОРКЕР (§5: «задачи определяются потребителями»):
 * пул передаёт в workerData.tasksModule — file URL модуля задач, экспортирующего
 * registerTasks({registerTask}) (образец: __fixtures__/workerpool-tasks.mjs;
 * потребитель 067 передаст свой собранный модуль через WorkerPoolOptions.tasksModule).
 * Воркер динамически импортирует модуль при старте и запускает цикл — сама точка
 * входа остаётся чистой инфраструктурой без прикладных импортов.
 *
 * ОГРАНИЧЕНИЯ ФАЙЛА (сознательные, не стилистика):
 *  - только node:* runtime-импорты и `import type` из './protocol.js' — в тестах
 *    файл исполняется нативным type-stripping Node (v22.18+/v24) прямо из .ts, где
 *    runtime-импорт './protocol.js' не резолвится (tsc-сборка приложения — dist, там
 *    файл лежит рядом с pool.js и default-entry пула резолвится штатно);
 *  - без enum/namespace/parameter-properties — strip-небезопасные формы (Amaro
 *    не трансформирует их);
 *  - без логгера: §18 (job start/end, краш) логирует сторона пула — у воркера нет
 *    файлового лога (правило §8: воркер чистый от БД/ключей и их окружения).
 *
 * ОТМЕНА (§5): кооперативная — abort-сообщение пула прерывает AbortSignal задачи;
 * обработчик сам решает, как завершиться. Поздние result/progress отменённой job
 * пул игнорирует по неизвестному jobId.
 *
 * ОШИБКИ (§13/§5): отказ обработчика → result ok:false (только эта job);
 * ошибка модуля задач/необработанное исключение → краш потока: пул видит 'error'/
 * 'exit', отклоняет активную job и перезапускает воркер (uncaughtException не
 * глушится намеренно — краш честно виден main-стороне).
 */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import type {
  MainToWorkerMessage,
  SerializedTaskError,
  TaskContext,
  TaskHandler,
} from './protocol.js';

/** Контракт модуля задач (единственный экспорт, читает worker.ts). */
export interface TasksModule {
  registerTasks(api: { registerTask: (name: string, handler: TaskHandler) => void }): void;
}

/** Реестр задач воркера (§7: Map name→fn; наполняется tasksModule при старте). */
const handlers = new Map<string, TaskHandler>();

/** Активные job воркера: jobId → контроллер отмены (кооперативная отмена §5). */
const activeJobs = new Map<number, AbortController>();

/**
 * Регистрация задачи (§7). Вызывается модулем задач через registerTasks({registerTask});
 * повторная регистрация того же имени замещает обработчик (последний выигрывает).
 */
export function registerTask(name: string, handler: TaskHandler): void {
  handlers.set(name, handler);
}

/** Читает file URL модуля задач из workerData (отсутствует — реестр пуст). */
function readTasksModule(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const tasksModule = (data as Record<string, unknown>)['tasksModule'];
  return typeof tasksModule === 'string' ? tasksModule : undefined;
}

/**
 * Сериализация ошибки задачи в форму протокола (protocol.ts SerializedTaskError):
 * Error → name/message/stack; прочий объект (в т.ч. AppError — не Error, TASK-006) →
 * целиком в cause, message — из поля message либо String(value); примитив — как есть.
 */
function serializeTaskError(value: unknown): SerializedTaskError {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'object' && value !== null) {
    const fields = value as Record<string, unknown>;
    const message = fields['message'];
    return {
      name: 'Object',
      // Строковое представление объекта нечитаемо ([object Object]) — общий текст,
      // детали уезжают в cause (потребитель читает code/messageKey и пр.).
      message: typeof message === 'string' ? message : 'non-error thrown in task',
      cause: value,
    };
  }
  return { name: typeof value, message: String(value) };
}

/** Отправка сообщения пулу (port сужён на вызывающей стороне). */
function post(port: MessagePort, message: Record<string, unknown>): void {
  port.postMessage(message);
}

/** Обрабатывает одно сообщение пула: run — выполнение задачи, abort — отмена (§7). */
async function handleMessage(port: MessagePort, raw: unknown): Promise<void> {
  const message = raw as MainToWorkerMessage;
  if (message.kind === 'abort') {
    activeJobs.get(message.jobId)?.abort();
    return;
  }
  if (message.kind !== 'run') {
    return; // неизвестный kind от доверенного пула — игнорируем (guard main-стороны зеркален)
  }
  const { jobId, name, payload } = message;
  const handler = handlers.get(name);
  if (handler === undefined) {
    // §13 fail-fast: неизвестное имя — отказ конкретной job, воркер живёт дальше.
    post(port, {
      kind: 'result',
      jobId,
      ok: false,
      error: { name: 'TaskError', message: `unknown task: ${name}` },
    });
    return;
  }
  const controller = new AbortController();
  activeJobs.set(jobId, controller);
  const context: TaskContext = {
    signal: controller.signal,
    reportProgress: (progress: number) => {
      post(port, { kind: 'progress', jobId, progress });
    },
  };
  try {
    const value = await handler(payload, context);
    post(port, { kind: 'result', jobId, ok: true, value });
  } catch (error) {
    post(port, { kind: 'result', jobId, ok: false, error: serializeTaskError(error) });
  } finally {
    activeJobs.delete(jobId);
  }
}

/**
 * Старт воркера: модуль задач (если задан) → подписка на сообщения пула. Ошибка
 * импорта модуля задач — краш потока: main-сторона перезапустит воркер (§13), а не
 * оставит «тихо пустой» реестр.
 */
async function main(): Promise<void> {
  const port = parentPort;
  if (port === null) {
    // Модуль импортирован вне worker_threads — цикл не запускается (реестр можно
    // наполнять только в потоке; повторный импорт файла как entry — единственный путь).
    return;
  }
  const tasksModule = readTasksModule(workerData);
  if (tasksModule !== undefined) {
    const imported: unknown = await import(tasksModule);
    const module = imported as Partial<TasksModule>;
    if (typeof module.registerTasks !== 'function') {
      throw new Error(`tasks module has no registerTasks export: ${tasksModule}`);
    }
    module.registerTasks({ registerTask });
  }
  port.on('message', (raw: unknown) => {
    void handleMessage(port, raw);
  });
}

await main();
