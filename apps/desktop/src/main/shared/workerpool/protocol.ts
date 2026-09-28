/**
 * TASK-066 §7: wire-протокол пула воркеров — спецификация обмена main ↔ worker.
 *
 * Направления:
 *   main → worker: {kind:'run', jobId, name, payload} и {kind:'abort', jobId};
 *   worker → main: {kind:'result', jobId, ok, value|error} и {kind:'progress', jobId, progress}.
 *
 * Разделение ответственности (важно для тестов §6 «unit протокола»):
 *   - типы сообщений и TaskContext импортирует и pool.ts, и worker.ts (в worker —
 *     ТОЛЬКО `import type`: файл грузится нативным type-stripping'ом Node в тестах
 *     прямо из .ts, где runtime-импорт './protocol.js' не резолвится — протокольные
 *     типы стираются, runtime-функции воркеру не нужны);
 *   - runtime-функции (guard, валидация прогресса, TaskError/toTaskError) живут на
 *     main-стороне пула: валидация входящих сообщений воркера защищает main от
 *     повреждённого/чужого сообщения (§14), сериализацию ошибки выполняет worker.ts
 *     локально (та же форма SerializedTaskError).
 *
 * Задачи (§5/§7) определяются потребителями: реестр — Map name→fn в воркере; тип
 * TaskMap задаёт тайпинг run() пула (потребитель 067 объявит свою карту задач).
 */

/** Контекст задачи в воркере (§5: кооперативная отмена + прогресс). */
export interface TaskContext {
  /** Сигнал отмены: abort приходит при отмене job на main-стороне (§5). */
  readonly signal: AbortSignal;
  /** Прогресс 0..1 — доставка подписчику run({onProgress}) (§7/§20). */
  reportProgress(progress: number): void;
}

/** Обработчик задачи: payload — данные пользователя (structured clone, §14). */
export type TaskHandler = (payload: unknown, context: TaskContext) => unknown;

/** Тип задачи: форма payload и результата (тайпинг run() пула, §5). */
export interface TaskDefinition {
  readonly payload: unknown;
  readonly result: unknown;
}

/** Карта задач пула: имя → определение (потребители расширяют, §7). */
export type TaskMap = Record<string, TaskDefinition>;

/** main → worker: запуск job (§7). */
export interface RunJobMessage {
  readonly kind: 'run';
  readonly jobId: number;
  readonly name: string;
  readonly payload: unknown;
}

/** main → worker: кооперативная отмена job (§5). */
export interface AbortJobMessage {
  readonly kind: 'abort';
  readonly jobId: number;
}

/** Сообщения main → worker. */
export type MainToWorkerMessage = RunJobMessage | AbortJobMessage;

/**
 * worker → main: ошибка задачи в сериализуемой форме (structured clone канала не
 * переносит прототипы Error — воркер сериализует явно; AppError (не Error, TASK-006)
 * уезжает целиком в cause — потребитель читает code/messageKey, §14: данные в памяти
 * той же машины).
 */
export interface SerializedTaskError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

/** worker → main: успешный результат job. */
export interface JobValueMessage {
  readonly kind: 'result';
  readonly jobId: number;
  readonly ok: true;
  readonly value: unknown;
}

/** worker → main: отказ job. */
export interface JobErrorMessage {
  readonly kind: 'result';
  readonly jobId: number;
  readonly ok: false;
  readonly error: SerializedTaskError;
}

/** worker → main: прогресс job (§7: 0..1). */
export interface JobProgressMessage {
  readonly kind: 'progress';
  readonly jobId: number;
  readonly progress: number;
}

/** Сообщения worker → main. */
export type WorkerToMainMessage = JobValueMessage | JobErrorMessage | JobProgressMessage;

/**
 * Runtime-guard входящих сообщений воркера (main-сторона): сообщения приходят из
 * отдельного потока — main обязан проверять форму перед диспетчеризацией (§14:
 * защита в глубину от повреждённого канала). Дисциплина any запрещена (§5) —
 * сужение через unknown и проверки полей.
 */
export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (typeof message['jobId'] !== 'number') {
    return false;
  }
  switch (message['kind']) {
    case 'result':
      // Ошибка обязательна только при ok:false — форма SerializedTaskError глубже
      // не проверяется (доверенный собственный воркер, guard против мусора канала).
      return message['ok'] === true || (message['ok'] === false && 'error' in message);
    case 'progress':
      return typeof message['progress'] === 'number';
    default:
      return false;
  }
}

/**
 * Прогресс обязан быть числом в диапазоне 0..1 (§7): значения вне диапазона
 * пул не доставляет подписчику (некорректный обработчик задачи — не повод ломать
 * контракт подписчика).
 */
export function isValidProgress(progress: number): boolean {
  return Number.isFinite(progress) && progress >= 0 && progress <= 1;
}

/**
 * Ошибка задачи/пула на main-стороне (§13 fail-fast: отклонение конкретного promise).
 * Единая форма отказа run() — потребитель различает сценарии по message/cause,
 * а не по классу (прецедент контракта ошибок каркаса).
 */
export class TaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TaskError';
  }
}

/** Собирает TaskError из сериализованной ошибки воркера (cause сохраняется). */
export function toTaskError(error: SerializedTaskError): TaskError {
  return error.cause !== undefined
    ? new TaskError(error.message, { cause: error.cause })
    : new TaskError(error.message);
}
