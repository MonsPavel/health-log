/**
 * TASK-066 §5/§13/§15: общий пул из 2 worker_threads (N=2 фикс — предсказуемость,
 * §4) для CPU-задач: PDF-рендер, экспорт 50k, тяжёлые series не блокируют main
 * (NFR-4). Точка расширения (§5, не в объёме): 50k-экспорт может уйти в этот же пул
 * — малые объёмы остаются в main (быстрее без overhead канала).
 *
 * ЖИЗНЕННЫЙ ЦИКЛ: воркеры создаются ЛЕНИВО при первой задаче (§5) и переиспользуются
 * (warm, §13). Занятость обоих → очередь FIFO (§13). run() отклоняет ТОЛЬКО свою
 * job (fail-fast §13).
 *
 * КРАШ (§13/§20): необработанная ошибка/exit воркера → активная job отклоняется
 * (TaskError «worker crashed»), воркер перезапускается с логом, очередь обслуживают
 * уцелевший и перезапущенный воркеры — ни одна job не теряется. Оговорка (§22):
 * задача, крашащая воркер на каждом запуске, даёт цикл перезапусков — в MVP задачи
 * пула ограничены по природе данных; таймаут-параметр — для вечных циклов.
 *
 * ТАЙМАУТ (§5/§22): опционален (по умолчанию нет); истечение → job отклоняется
 * («timed out»), воркер terminate (кооперативный abort вечному циклу не поможет)
 * и перезапускается. ОТМЕНА (§5): кооперативная — внешний AbortSignal доставляет
 * abort задаче, run() отклоняется сразу, воркер НЕ крашится и остаётся тёплым.
 * Потребители сами решают, поддерживать ли отмену: задача PDF (067) в MVP НЕ
 * отменяется (документировано §5) — механизм сигнала ей просто не передаётся.
 *
 * TERMINATE (§9/AC4): все активные и ожидающие job отклоняются («terminated») —
 * shutdown не висит; повторный вызов и run() после terminate — отказ. PDF, потерянный
 * в момент закрытия приложения, — допустимо (§9, документировано).
 *
 * ЛОГ (§18): job start/end (name, jobId, durationMs), краш воркера — error
 * (logDiagnostic со стеком); категория job. Воркер сам не логирует (см. worker.ts).
 *
 * БЕЗОПАСНОСТЬ (§14): payload — данные пользователя в памяти воркера той же машины
 * (допустимо); воркеры без доступа к БД/ключу (§8); входящие сообщения воркера
 * проходят guard протокола (protocol.ts) — защита main от повреждённого канала.
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { createLogger, logDiagnostic, type HlLogger } from '../logger/logger.js';
import {
  isWorkerToMainMessage,
  isValidProgress,
  TaskError,
  toTaskError,
  type TaskMap,
} from './protocol.js';

/** Размер пула (§4: N=2 фикс — параллельный PDF+экспорт без CPU-переподписки). */
const DEFAULT_POOL_SIZE = 2;

/** Опции пула (§5/§6; всё переопределяемо — тесты §19 подставляют .ts-entry и fixture). */
export interface WorkerPoolOptions {
  /** Число воркеров; по умолчанию 2 (§4). */
  readonly size?: number;
  /**
   * Модуль-точка входа воркера; по умолчанию — собранный worker.js рядом с pool.js
   * (tsc-сборка dist). Тесты подставляют исходник worker.ts (type-stripping Node).
   */
  readonly entryUrl?: string | URL;
  /**
   * File URL модуля задач (см. worker.ts): экспортирует registerTasks({registerTask}).
   * Не задан — реестр воркера пуст (всякая run() отклонится «unknown task»).
   */
  readonly tasksModule?: string;
  /** Логгер пула (§18); по умолчанию createLogger('job'). */
  readonly logger?: HlLogger;
}

/** Опции запуска задачи (§5): прогресс, кооперативная отмена, таймаут. */
export interface RunOptions {
  /** Подписчик прогресса 0..1 (§7/§20 AC5); значения вне 0..1 не доставляются. */
  readonly onProgress?: (progress: number) => void;
  /** Кооперативная отмена (§5): abort доставляется задаче, run() отклоняется. */
  readonly signal?: AbortSignal;
  /** Таймаут мс (§5/§22): по умолчанию таймаута нет. */
  readonly timeoutMs?: number;
}

/** Job в очереди (FIFO §13). */
interface QueuedJob {
  readonly jobId: number;
  readonly name: string;
  readonly payload: unknown;
  readonly options: RunOptions | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Job на воркере: плюс старт-время, таймер таймаута и обработчик отмены. */
interface ActiveJob extends QueuedJob {
  readonly poolWorker: PoolWorker;
  readonly startedAtMs: number;
  timeoutHandle: NodeJS.Timeout | undefined;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
}

/** Аргументы abort-обработчика, известные до создания ActiveJob (ссылка появляется
 *  после литерала — замыкание читает holder). */
interface AbortWiring {
  readonly poolWorker: PoolWorker;
  readonly jobId: number;
  readonly name: string;
  active: ActiveJob | undefined;
}

/** Обёртка потока воркера (состояние диспетчеризации пула). */
interface PoolWorker {
  readonly worker: Worker;
  /** Текущая job (undefined — простаивает). */
  active: ActiveJob | undefined;
  /** Намеренное terminate (таймаут/пул): exit не считается крашем. */
  terminating: boolean;
}

/** Итог job: success | failure (внутренняя дискриминация). */
type JobOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: TaskError;
    };

/**
 * Пул воркеров (§5): run<TaskName>(name, payload, {onProgress?, signal?, timeoutMs?}).
 * Тайпинг: Tasks — карта задач (protocol.TaskMap); по умолчанию произвольные имена
 * с payload/result unknown — потребитель 067 объявит точную карту (задел §7).
 */
export class WorkerPool<Tasks extends TaskMap = TaskMap> {
  private readonly size: number;
  private readonly entryUrl: string | URL;
  private readonly tasksModule: string | undefined;
  private readonly logger: HlLogger;

  private readonly workers = new Set<PoolWorker>();
  private readonly queue: QueuedJob[] = [];
  private readonly activeJobs = new Map<number, ActiveJob>();
  private nextJobId = 1;
  private terminated = false;
  private terminatedPromise: Promise<void> | undefined;

  constructor(options: WorkerPoolOptions = {}) {
    this.size = options.size ?? DEFAULT_POOL_SIZE;
    // Default — собранный воркер рядом с pool.js: tsc dist/main/shared/workerpool/.
    this.entryUrl = options.entryUrl ?? new URL('./worker.js', import.meta.url);
    this.tasksModule = options.tasksModule;
    this.logger = options.logger ?? createLogger('job');
  }

  /**
   * Запуск задачи (§5): promise результата/ошибки. При terminated — сразу отказ
   * (shutdown не висит, AC4); иначе job встаёт в очередь и диспетчеризируется.
   */
  run<K extends keyof Tasks & string>(
    name: K,
    payload: Tasks[K]['payload'],
    options?: RunOptions,
  ): Promise<Tasks[K]['result']> {
    if (this.terminated) {
      return Promise.reject(new TaskError('pool is terminated'));
    }
    const jobId = this.nextJobId;
    this.nextJobId += 1;
    return new Promise<Tasks[K]['result']>((resolve, reject) => {
      this.queue.push({
        jobId,
        name,
        payload,
        options,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /**
   * Останов пула (§9/AC4): отклоняет активные и ожидающие job, terminate потоков.
   * Идемпотентен; повторный вызов возвращает прежний promise. Потоки воркеров
   * завершаются принудительно — «оборвать с логом» (§9: потерянный PDF допустим).
   */
  terminate(): Promise<void> {
    if (this.terminatedPromise !== undefined) {
      return this.terminatedPromise;
    }
    this.terminated = true;
    for (const job of [...this.activeJobs.values()]) {
      this.finish(job, { ok: false, error: new TaskError('pool is terminated') }, undefined);
    }
    for (const job of this.queue.splice(0, this.queue.length)) {
      job.reject(new TaskError('pool is terminated'));
      this.logger.info('job dropped', { name: job.name, jobId: job.jobId });
    }
    const terminations = [...this.workers].map((poolWorker) => {
      poolWorker.terminating = true;
      return poolWorker.worker.terminate();
    });
    this.workers.clear();
    this.terminatedPromise = Promise.all(terminations).then(() => undefined);
    this.logger.info('worker pool terminated', { workers: terminations.length });
    return this.terminatedPromise;
  }

  // --- диспетчеризация (§13: FIFO; ленивое создание §5) ---

  /** Раздаёт очередь: простаивающим воркерам, иначе добирает воркеры до size. */
  private pump(): void {
    while (this.queue.length > 0) {
      const idle = this.idleWorker();
      if (idle !== undefined) {
        this.dispatch(idle, this.queue.shift());
        continue;
      }
      if (this.workers.size < this.size) {
        this.dispatch(this.spawnWorker(), this.queue.shift());
        continue;
      }
      break; // оба заняты — job ждёт в очереди (FIFO §13)
    }
  }

  private idleWorker(): PoolWorker | undefined {
    for (const poolWorker of this.workers) {
      if (!poolWorker.terminating && poolWorker.active === undefined) {
        return poolWorker;
      }
    }
    return undefined;
  }

  /** Назначает job воркеру: подписки, таймер таймаута, abort-обработчик, лог старта. */
  private dispatch(poolWorker: PoolWorker, job: QueuedJob | undefined): void {
    if (job === undefined) {
      return;
    }
    const signal = job.options?.signal;
    const abortWiring: AbortWiring = {
      poolWorker,
      jobId: job.jobId,
      name: job.name,
      active: undefined,
    };
    const onAbort = (): void => {
      const activeJob = abortWiring.active;
      if (activeJob === undefined) {
        return;
      }
      this.logger.info('job aborted', { name: activeJob.name, jobId: activeJob.jobId });
      // Воркер НЕ освобождаем: обработчик может ещё крутиться до проверки сигнала
      // (кооперативная отмена §5) — освободит своим result (поздний, игнор по id).
      try {
        poolWorker.worker.postMessage({ kind: 'abort', jobId: activeJob.jobId });
      } catch {
        // поток уже мёртв — краш обработан exit/error-событием
      }
      this.finish(activeJob, { ok: false, error: new TaskError('job aborted') }, undefined);
    };
    const active: ActiveJob = {
      ...job,
      poolWorker,
      startedAtMs: performance.now(),
      timeoutHandle: undefined,
      signal,
      onAbort,
    };
    abortWiring.active = active;
    poolWorker.active = active;
    this.activeJobs.set(job.jobId, active);
    this.logger.info('job start', { name: job.name, jobId: job.jobId });

    try {
      // structured clone payload (§4/§15: ~десятки мс на 10 МБ — приемлемо); отказ
      // клонирования (функции и пр.) — fail-fast конкретной job (§13).
      poolWorker.worker.postMessage({
        kind: 'run',
        jobId: job.jobId,
        name: job.name,
        payload: job.payload,
      });
    } catch (error) {
      this.finish(
        active,
        {
          ok: false,
          error: new TaskError('payload is not structured-cloneable', { cause: error }),
        },
        poolWorker,
      );
      return;
    }

    const timeoutMs = job.options?.timeoutMs;
    if (timeoutMs !== undefined) {
      active.timeoutHandle = setTimeout(() => {
        this.logger.warn('job timed out; worker terminated', {
          name: job.name,
          jobId: job.jobId,
          timeoutMs,
        });
        // Кооперативный abort вечному циклу не поможет: terminate потока (§22) и
        // перезапуск; job отклоняется, очередь живёт (см. шапку).
        poolWorker.terminating = true;
        this.finish(
          active,
          { ok: false, error: new TaskError(`task timed out after ${timeoutMs}ms`) },
          poolWorker,
        );
        void poolWorker.worker.terminate();
        this.respawn();
      }, timeoutMs);
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        // Отмена пришла до распределения: обрабатываем как обычный abort (§5).
        active.onAbort();
        return;
      }
      signal.addEventListener('abort', active.onAbort, { once: true });
    }
  }

  /** Перезапуск после краша/таймаута (§13): новый тёплый воркер разбирает очередь. */
  private respawn(): void {
    if (this.terminated) {
      return;
    }
    this.spawnWorker();
    this.pump();
  }

  private spawnWorker(): PoolWorker {
    const worker = new Worker(this.entryUrl, {
      workerData: { tasksModule: this.tasksModule },
      name: 'hl-worker-pool',
    });
    const poolWorker: PoolWorker = { worker, active: undefined, terminating: false };
    this.workers.add(poolWorker);
    worker.on('message', (raw: unknown) => {
      this.onWorkerMessage(poolWorker, raw);
    });
    worker.on('error', (error: Error) => {
      this.onWorkerCrash(poolWorker, { kind: 'error', error });
    });
    worker.on('exit', (code: number) => {
      this.onWorkerExit(poolWorker, code);
    });
    return poolWorker;
  }

  // --- события воркера ---

  /** Сообщения воркера: guard протокола (§14), прогресс — подписчику, result — settle. */
  private onWorkerMessage(poolWorker: PoolWorker, raw: unknown): void {
    if (!isWorkerToMainMessage(raw)) {
      this.logger.warn('malformed worker message ignored');
      return;
    }
    if (raw.kind === 'progress') {
      const job = this.activeJobs.get(raw.jobId);
      if (job === undefined) {
        return; // поздний прогресс отменённой job — игнор (кооперативная отмена §5)
      }
      if (!isValidProgress(raw.progress)) {
        this.logger.warn('invalid progress ignored', {
          name: job.name,
          jobId: job.jobId,
          progress: raw.progress,
        });
        return;
      }
      job.options?.onProgress?.(raw.progress);
      return;
    }
    const job = this.activeJobs.get(raw.jobId);
    if (job === undefined) {
      // Поздний результат отменённой/просроченной job: воркер освободить (warm §13).
      if (poolWorker.active?.jobId === raw.jobId) {
        poolWorker.active = undefined;
        this.pump();
      }
      return;
    }
    if (raw.ok) {
      this.finish(job, { ok: true, value: raw.value }, poolWorker);
    } else {
      this.finish(job, { ok: false, error: toTaskError(raw.error) }, poolWorker);
    }
  }

  /** Необработанная ошибка в воркере (в т.ч. отказ модуля задач при старте). */
  private onWorkerCrash(
    poolWorker: PoolWorker,
    crash: { kind: 'error'; error: Error } | { kind: 'exit'; code: number },
  ): void {
    if (poolWorker.terminating || this.terminated) {
      return; // намеренный terminate — не краш (exit-событие лишь почистит set)
    }
    poolWorker.terminating = true;
    const job = poolWorker.active;
    poolWorker.active = undefined;
    if (job !== undefined) {
      this.finish(
        job,
        { ok: false, error: new TaskError(`worker crashed: ${describeCrash(crash)}`) },
        undefined,
      );
    }
    if (crash.kind === 'error') {
      logDiagnostic(this.logger, crash.error, { context: 'worker crashed' });
    } else {
      this.logger.error('worker crashed', { exitCode: crash.code });
    }
    this.respawn();
  }

  /** exit после краша: чистка set (job уже обработана onWorkerCrash либо terminate). */
  private onWorkerExit(poolWorker: PoolWorker, code: number): void {
    this.workers.delete(poolWorker);
    if (!poolWorker.terminating && !this.terminated) {
      // exit без 'error' (например, process.exit в задаче) — тоже краш (§13/§19).
      this.onWorkerCrash(poolWorker, { kind: 'exit', code });
    }
  }

  // --- завершение job (идемпотентно: защита от двойного отклонения) ---

  /**
     Settle job ровно один раз: снимает таймер/abort-подписку, лог конца (§18),
     резолвит/отклоняет promise; releasingWorker — воркер, освободившийся для очереди.
     */
  private finish(
    job: ActiveJob,
    outcome: JobOutcome,
    releasingWorker: PoolWorker | undefined,
  ): void {
    if (this.activeJobs.get(job.jobId) !== job) {
      return; // уже завершена (таймаут/краш/отмена) — повторный settle недопустим
    }
    this.activeJobs.delete(job.jobId);
    if (job.timeoutHandle !== undefined) {
      clearTimeout(job.timeoutHandle);
    }
    if (job.signal !== undefined) {
      job.signal.removeEventListener('abort', job.onAbort);
    }
    const durationMs = Math.max(0, Math.round(performance.now() - job.startedAtMs));
    if (outcome.ok) {
      job.resolve(outcome.value);
    } else {
      job.reject(outcome.error);
    }
    this.logger.info('job end', { name: job.name, jobId: job.jobId, durationMs, ok: outcome.ok });
    if (releasingWorker !== undefined && releasingWorker.active === job) {
      releasingWorker.active = undefined;
      this.pump();
    }
  }
}

/** Человекочитаемое описание краша для сообщения TaskError (§13). */
function describeCrash(
  crash: { kind: 'error'; error: Error } | { kind: 'exit'; code: number },
): string {
  return crash.kind === 'error' ? crash.error.message : `exit code ${crash.code}`;
}
