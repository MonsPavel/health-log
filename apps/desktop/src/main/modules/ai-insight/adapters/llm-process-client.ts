/**
 * TASK-076 §5/§9: main-side клиент llm-worker — spawn UtilityProcess (entry
 * llm-worker.js), MessagePort-handshake, протокол load/unload/complete/cancel,
 * автоматический перезапуск после краша и события renderer'у ai:status/ai:token.
 *
 * СОСТОЯНИЯ (§7): starting (spawn/авто-reload) → ready → busy → ready; краш →
 * restarting (backoff 1 с, максимум 3 ПОДРЯД: 4-й краш без закрытия гейта →
 * failed); cancel идемпотентен; unload при активной генерации отклоняется (§20).
 *
 * ГОТОВНОСТЬ/HANDSHAKE (§15): spawn ленивый — при первой операции. 'ready'
 * воркера — ack load; «гейт готовности» процесса (его await'ит каждая операция)
 * закрывается ack'ом load (или сразу, если модель не требовалась). После
 * перезапуска клиент ПОМНИТ последнюю загруженную модель (§13 «следующая
 * генерация работает») и автоматически переотправляет load — генерации ждут
 * закрытия гейта. Воркер без модели готов сразу (генерация честно упадёт
 * ENGINE_NOT_CONFIGURED до TASK-077). Пользовательские load сериализуются
 * очередью (§23: переключение модели = unload+load, вне генерации).
 *
 * ТЕРМИНАЛЬНОСТЬ ОПЕРАЦИЙ (§7; ревью TASK-076): операция, стоявшая в очереди за
 * чужим pendingCall/loadQueue в момент краша, после освобождения слота
 * маршрутизируется заново через ensureAlive (дождаться рестарта/заспавнить) —
 * queued load доходит НОВОМУ воркеру. Если доставка всё же не состоялась
 * (процесс умер в том же тике), send() возвращает false и операция получает
 * немедленный отказ AI/WORKER_CRASHED — вечных pending нет; complete в этом
 * случае отклоняется сразу, не дожидаясь watchdog.
 *
 * БАТЧИНГ ТОКЕНОВ (§11 — деталь зафиксирована): delta воркера копятся в буфер и
 * доставляются подписчику И renderer'у (ai:token) одной пачкой раз в 50 мс —
 * частота ≤20/с приемлема для канала hl:event. done дочищает буфер ДО резолва
 * (порядок токены→done сохраняется).
 *
 * КРАШ/WATCHDOG (§13/§22): exit процесса → активный requestId и ожидающие
 * load/unload отклоняются AI/WORKER_CRASHED; перезапуск с backoff; счётчик
 * подряд-крашей сбрасывается закрытием гейта (процесс доказал живучесть).
 * Watchdog §22: генерация без токенов/done дольше idleTimeoutMs (дефолт 30 с) →
 * kill + путь краша (перезапуск). Watchdog покрывает только активную генерацию —
 * зависание до handshake без exit не в формулировке §22 («нет done, нет токенов»).
 *
 * ОШИБКИ (§9/§13): наружу AppError: AI/BUSY, AI/WORKER_CRASHED,
 * AI/ENGINE_NOT_CONFIGURED, AI/MODEL_NOT_FOUND (§14 — путь валидируется
 * существованием ДО передачи воркеру; в params basename, не полный путь:
 * userData содержит имя Windows-пользователя, §18). Неизвестный код воркера →
 * APP/INTERNAL с params.code (мост для кодов движка 077). Системный отказ
 * spawn-фабрики (entry недоступен) — APP/INTERNAL БЕЗ цикла перезапусков.
 *
 * БЕЗОПАСНОСТЬ (§14): ответы воркера проходят guard контракта (isWorkerResponse)
 * — повреждённый канал не диспетчеризуется; клиент шлёт воркеру только протокол.
 *
 * ЛОГ (§18): spawn/exit/crash/restart и requestId генераций (без содержимого);
 * логгер структурный (adapters не импортируют shared — матрица арх. 03 §4;
 * прецедент EventBus.EventsLogger); боевой — createLogger('ai').
 *
 * ТРАНСПОРТ (§4): spawn внедряется (§19); боевой — createDefaultLlmWorkerSpawn
 * (utilityProcess.fork + MessageChannelMain, ленивый import electron — прецедент
 * createDefaultEgressFetch); вне Electron-рантайма фабрика честно бросает при
 * ВЫЗОВЕ (сборка контейнера в node-vitest не спавнит).
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isWorkerResponse,
  type AiWorkerState,
  type ChatMessage,
  type GenerationParams,
  type HlEventMap,
  type LlmFinishReason,
  type WorkerRequest,
  type WorkerResponse,
} from '@hl/contracts';
import { AppError } from '@hl/kernel';

import { AI_BUSY_MESSAGE_KEY } from '../application/ports/llm-engine.js';

/**
 * Ключ i18n для AI/BUSY (конвенция арх. 05 §29; тексты — TASK-101). TASK-078:
 * единственный источник строки — порт LlmEngine (application/ports/llm-engine) —
 * здесь реэкспорт для совместимости (прецедент: контракт ошибок живёт в порту).
 */
export { AI_BUSY_MESSAGE_KEY } from '../application/ports/llm-engine.js';
/** Ключ i18n для AI/WORKER_CRASHED. */
export const AI_WORKER_CRASHED_MESSAGE_KEY = 'errors.AI_WORKER_CRASHED';
/** Ключ i18n для AI/ENGINE_NOT_CONFIGURED. */
export const AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY = 'errors.AI_ENGINE_NOT_CONFIGURED';
/** Ключ i18n для AI/MODEL_NOT_FOUND. */
export const AI_MODEL_NOT_FOUND_MESSAGE_KEY = 'errors.AI_MODEL_NOT_FOUND';

/** Дефолты жизненного цикла (§5/§11/§22 — детали зафиксированы спекой). */
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_TOKEN_FLUSH_MS = 50;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Порт в воркер (структурно MessagePortMain; тесты — мок §19). */
export interface LlmWorkerPort {
  postMessage(message: WorkerRequest): void;
  onMessage(listener: (message: WorkerResponse) => void): void;
  start(): void;
  close(): void;
}

/** Заспавненный процесс воркера (структурно Electron UtilityProcess). */
export interface LlmWorkerProcess {
  readonly port: LlmWorkerPort;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

/** Фабрика процесса: entry-путь → процесс (§19: подмена в тестах). */
export type SpawnLlmWorker = (entryPath: string) => LlmWorkerProcess;

/** Структурный логгер клиента (§18; боевой — createLogger('ai')). */
export interface LlmClientLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Доставка событий renderer'у (§11): боевой мост — broadcastToWindows (TASK-009). */
export type LlmNotify = <K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]) => void;

/** Опции клиента (§5; всё переопределяемо — тесты §19). */
export interface LlmProcessClientOptions {
  /** Фабрика процесса; по умолчанию — честный отказ (контейнер внедряет боевую). */
  readonly spawn?: SpawnLlmWorker;
  /** Entry воркера; по умолчанию — собранный llm-worker/main.js рядом (dist). */
  readonly entryPath?: string;
  /** Мост событий ai:status/ai:token; по умолчанию — no-op (тесты подставляют spy). */
  readonly notify?: LlmNotify;
  readonly logger?: LlmClientLogger;
  /** Валидация пути модели (§14); по умолчанию existsSync. */
  readonly pathExists?: (path: string) => boolean;
  /** Backoff перезапуска, мс (§5: 1000). */
  readonly restartBackoffMs?: number;
  /** Максимум перезапусков подряд (§5: 3; следующий краш без гейта → failed). */
  readonly maxRestartAttempts?: number;
  /** Интервал батчинга токенов, мс (§11: 50). */
  readonly tokenFlushMs?: number;
  /** Watchdog генерации без отклика, мс (§22: 30 000). */
  readonly idleTimeoutMs?: number;
}

/** Запрос генерации (форма complete без requestId — он параметр метода, §5). */
export interface LlmCompleteRequest {
  readonly messages: readonly ChatMessage[];
  readonly params?: GenerationParams;
  readonly maxTokens: number;
}

/** Подписки complete (§5): токены — пачками; done/error — resolve/reject promise. */
export interface LlmCompleteHandlers {
  readonly onToken?: (text: string) => void;
}

/** Результат генерации (§7: done|cancelled). */
export interface LlmCompleteResult {
  readonly finishReason: LlmFinishReason;
}

/** Собранный entry воркера по умолчанию: dist/main/llm-worker/main.js. */
const DEFAULT_ENTRY_PATH = fileURLToPath(new URL('../../../llm-worker/main.js', import.meta.url));

/** Молчун-логгер (дефолт; боевой внедряет контейнер). */
const SILENT_LOGGER: LlmClientLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Ожидание load/unload на порту (слот один; пользовательские load — в очереди). */
interface PendingCall {
  readonly done: Promise<void>;
  resolve(): void;
  reject(error: AppError): void;
}

/** Активная генерация (реестр — одна, §5). */
interface ActiveGeneration {
  readonly requestId: string;
  readonly handlers: LlmCompleteHandlers | undefined;
  readonly resolvers: {
    resolve(result: LlmCompleteResult): void;
    reject(error: AppError): void;
  };
  settled: boolean;
  cancelSent: boolean;
}

/** Живой процесс: handle + гейт готовности (§15) и служебные флаги. */
interface AliveProcess {
  readonly handle: LlmWorkerProcess;
  readonly readyPromise: Promise<void>;
  readyReject(error: AppError): void;
  /** Гейт закрыт — процесс доказал готовность; счётчик подряд-крашей обнулён. */
  readinessDone: boolean;
  /** kill по dispose — exit не считается крашем (перезапуска нет, §9). */
  disposeKill: boolean;
}

/** Минимальные формы Electron utilityProcess/MessageChannelMain (структурно, §4). */
interface ElectronPortMainLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
  close(): void;
}

interface ElectronUtilityProcessLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: 'exit', listener: (code: number) => void): void;
  kill(): void;
}

interface ElectronModulesLike {
  utilityProcess?: {
    fork(
      modulePath: string,
      args?: readonly string[],
      options?: { serviceName?: string },
    ): ElectronUtilityProcessLike;
  };
  MessageChannelMain?: new () => { port1: ElectronPortMainLike; port2: ElectronPortMainLike };
}

/**
 * Боевой spawn (§4): utilityProcess.fork + MessageChannelMain (один конец —
 * воркеру через postMessage с transfer, второй — клиенту). Ленивый import
 * electron: в node-рантайме (vitest) модуля нет — фабрика честно бросает при
 * вызове (сборка контейнера не спавнит, прецедент createDefaultEgressFetch).
 */
export async function createDefaultLlmWorkerSpawn(): Promise<SpawnLlmWorker> {
  try {
    const electron = (await import('electron')) as ElectronModulesLike;
    const utilityProcess = electron.utilityProcess;
    const MessageChannelMain = electron.MessageChannelMain;
    if (utilityProcess !== undefined && MessageChannelMain !== undefined) {
      return (entryPath) => {
        const { port1, port2 } = new MessageChannelMain();
        const child = utilityProcess.fork(entryPath, [], { serviceName: 'llm-worker' });
        // Официальный handshake UtilityProcess (§4/§5): передаём порт воркеру.
        child.postMessage({ type: 'hl-llm-worker-port' }, [port2]);
        return {
          port: {
            postMessage: (message) => {
              port1.postMessage(message);
            },
            onMessage: (listener) => {
              port1.on('message', (event) => {
                listener(event.data as WorkerResponse);
              });
            },
            start: () => {
              port1.start();
            },
            close: () => {
              port1.close();
            },
          },
          onExit: (listener) => {
            child.on('exit', (code) => {
              listener(code);
            });
          },
          kill: () => {
            child.kill();
          },
        };
      };
    }
  } catch {
    // Не Electron-рантайм (vitest/node) — честный отказ ниже.
  }
  return (entryPath) => {
    throw new Error(
      `llm-worker: UtilityProcess недоступен вне Electron-рантайма (entry: ${entryPath})`,
    );
  };
}

/** Карта кода воркера → AppError (§9/§13; неизвестный — APP/INTERNAL с params.code). */
function toAppError(code: string): AppError {
  switch (code) {
    case 'BUSY':
      return AppError.of('AI/BUSY', AI_BUSY_MESSAGE_KEY);
    case 'ENGINE_NOT_CONFIGURED':
      return AppError.of('AI/ENGINE_NOT_CONFIGURED', AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY);
    default:
      return AppError.of('APP/INTERNAL', 'errors.internal', { code });
  }
}

function workerCrashedError(reason: string): AppError {
  return AppError.of('AI/WORKER_CRASHED', AI_WORKER_CRASHED_MESSAGE_KEY, { reason });
}

function disposedError(): AppError {
  return AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'llm-client-disposed' });
}

/** Клиент llm-worker (§5/§9): singleton контейнера. */
export class LlmProcessClient {
  private readonly spawn: SpawnLlmWorker;
  private readonly entryPath: string;
  private readonly notify: LlmNotify;
  private readonly logger: LlmClientLogger;
  private readonly pathExists: (path: string) => boolean;
  private readonly restartBackoffMs: number;
  private readonly maxRestartAttempts: number;
  private readonly tokenFlushMs: number;
  private readonly idleTimeoutMs: number;

  private disposed = false;
  private stateValue: AiWorkerState = 'starting';
  private alive: AliveProcess | undefined;
  /** Гейт запланированного перезапуска (await'ится операциями, §13). */
  private restartGate: Promise<AliveProcess> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private consecutiveCrashes = 0;

  private active: ActiveGeneration | undefined;
  private pendingCall: PendingCall | undefined;
  /** Очередь пользовательских load (§23: переключение = unload+load). */
  private loadQueue: Promise<void> = Promise.resolve();
  private lastModelPath: string | undefined;

  private tokenBuffer = '';
  private flushTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(options: LlmProcessClientOptions = {}) {
    this.spawn =
      options.spawn ??
      (() => {
        throw new Error(
          'llm-worker: spawn не внедрён (контейнер передаёт createDefaultLlmWorkerSpawn)',
        );
      });
    this.entryPath = options.entryPath ?? DEFAULT_ENTRY_PATH;
    this.notify = options.notify ?? (() => undefined);
    this.logger = options.logger ?? SILENT_LOGGER;
    this.pathExists = options.pathExists ?? existsSync;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    this.tokenFlushMs = options.tokenFlushMs ?? DEFAULT_TOKEN_FLUSH_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** Текущий статус воркера (§7) — потребитель TASK-088, тесты §19. */
  get state(): AiWorkerState {
    return this.stateValue;
  }

  /**
   * Загрузить модель (§5/§14). Путь валидируется существованием ДО spawn/отправки;
   * при активной генерации — AI/BUSY (§23). Вызовы сериализуются очередью.
   */
  load(modelPath: string): Promise<void> {
    if (this.disposed) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006)
      return Promise.reject(disposedError());
    }
    if (this.active !== undefined) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006)
      return Promise.reject(AppError.of('AI/BUSY', AI_BUSY_MESSAGE_KEY));
    }
    if (!this.pathExists(modelPath)) {
      // §14/§18: наружу basename, не полный путь (userData содержит имя пользователя).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006)
      return Promise.reject(
        AppError.of('AI/MODEL_NOT_FOUND', AI_MODEL_NOT_FOUND_MESSAGE_KEY, {
          model: basename(modelPath),
        }),
      );
    }
    const run = async (): Promise<void> => {
      await this.ensureAlive();
      // Незакрытый unload/auto-вызов (гонка) — дожидаемся его слота.
      while (this.pendingCall !== undefined) {
        await this.pendingCall.done.catch(() => undefined);
      }
      // Слот мог освободиться КРАШОМ (ревью TASK-076): процесс умер, пока эта
      // операция стояла за чужим pendingCall — маршрутизируем заново через
      // ensureAlive (дождаться рестарта/заспавнить), иначе send уйдёт в мёртвый
      // процесс и promise зависнет навсегда (§7: у операции терминальное состояние).
      await this.ensureAlive();
      const pending = this.createPendingCall();
      this.pendingCall = {
        ...pending,
        resolve: () => {
          this.lastModelPath = modelPath;
          pending.resolve();
        },
      };
      if (!this.send({ type: 'load', modelPath })) {
        // Доставка не состоялась (процесс умер в этом же тике, exit ещё не дошёл) —
        // терминальный отказ немедленно; exit-путь слот уже не увидит (очищен).
        this.pendingCall = undefined;
        pending.reject(workerCrashedError('exit'));
      }
      return pending.done;
    };
    const result = this.loadQueue.then(run, run);
    this.loadQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Выгрузить модель (§5). При активной генерации — AI/BUSY (§20); воркера нет
   * и рестарт не планируется — no-op (выгружать нечего).
   */
  async unload(): Promise<void> {
    if (this.disposed) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw disposedError();
    }
    if (this.active !== undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw AppError.of('AI/BUSY', AI_BUSY_MESSAGE_KEY);
    }
    if (this.alive === undefined && this.restartGate === undefined) {
      return;
    }
    await this.ensureAlive();
    await this.loadQueue.catch(() => undefined);
    while (this.pendingCall !== undefined) {
      await this.pendingCall.done.catch(() => undefined);
    }
    // Слот мог освободиться КРАШОМ (ревью TASK-076) — см. комментарий в load().
    await this.ensureAlive();
    const pending = this.createPendingCall();
    this.pendingCall = {
      ...pending,
      resolve: () => {
        this.lastModelPath = undefined;
        pending.resolve();
      },
    };
    if (!this.send({ type: 'unload' })) {
      this.pendingCall = undefined;
      pending.reject(workerCrashedError('exit'));
    }
    return pending.done;
  }

  /**
   * Генерация (§5/§9): одновременная одна — вторая → AI/BUSY (быстрый guard,
   * воркер страхует тем же кодом). Токены — пачками в onToken и ai:token (§11);
   * done резолвит, адресный error — отклоняет по карте кодов.
   */
  async complete(
    requestId: string,
    request: LlmCompleteRequest,
    handlers?: LlmCompleteHandlers,
  ): Promise<LlmCompleteResult> {
    if (this.disposed) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw disposedError();
    }
    if (this.active !== undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw AppError.of('AI/BUSY', AI_BUSY_MESSAGE_KEY);
    }
    await this.ensureAlive();
    // Пользовательский load обязан дойти до воркера раньше генерации (§23).
    await this.loadQueue.catch(() => undefined);
    if (this.active !== undefined) {
      // Вторая из двух гонок complete — отклоняется здесь, а не уходить воркеру.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw AppError.of('AI/BUSY', AI_BUSY_MESSAGE_KEY);
    }
    return new Promise<LlmCompleteResult>((resolve, reject) => {
      const generation: ActiveGeneration = {
        requestId,
        handlers,
        resolvers: { resolve, reject },
        settled: false,
        cancelSent: false,
      };
      this.active = generation;
      this.setState('busy', requestId);
      const delivered = this.send({
        type: 'complete',
        requestId,
        messages: request.messages,
        params: request.params,
        maxTokens: request.maxTokens,
      });
      if (!delivered) {
        // Доставка не состоялась (процесс умер до отправки) — терминальный отказ
        // СРАЗУ, а не по истечении watchdog (§7; ревью TASK-076). Статус уже
        // переведён exit-путём (restarting/failed) — 'ready' здесь не эмитим.
        this.failGeneration(generation, workerCrashedError('exit'), false);
        return;
      }
      this.resetIdleTimer();
    });
  }

  /**
   * Отменить генерацию (§13): идемпотентно — незнакомый/повторный/после done
   * requestId молча игнорируется; поток закроет done(cancelled).
   */
  cancel(requestId: string): void {
    const generation = this.active;
    if (generation === undefined || generation.requestId !== requestId || generation.cancelSent) {
      return;
    }
    generation.cancelSent = true;
    this.send({ type: 'cancel', requestId });
  }

  /**
   * Останов клиента (§9 graceful shutdown): активная генерация и ожидания
   * отклоняются, процесс убивается без перезапуска; идемпотентен.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.restartGate = undefined;
    const generation = this.active;
    if (generation !== undefined && !generation.settled) {
      this.failGeneration(generation, disposedError(), false);
    }
    if (this.pendingCall !== undefined) {
      const pending = this.pendingCall;
      this.pendingCall = undefined;
      pending.reject(disposedError());
    }
    this.clearIdleTimer();
    this.discardTokens();
    const alive = this.alive;
    if (alive !== undefined) {
      alive.disposeKill = true;
      if (!alive.readinessDone) {
        alive.readyReject(disposedError());
      }
      alive.handle.kill();
    }
    this.logger.info('llm-worker: клиент остановлен (dispose)');
  }

  // --- внутреннее: статусы и события ---

  private setState(state: AiWorkerState, requestId?: string): void {
    this.stateValue = state;
    try {
      if (requestId === undefined) {
        this.notify('ai:status', { state });
      } else {
        this.notify('ai:status', { state, requestId });
      }
    } catch (cause) {
      // Мост доставки не рвёт жизненный цикл (§9, прецедент broadcast).
      this.logger.debug('llm-worker: ai:status не доставлен', { state, cause });
    }
  }

  /** Переход в ready без дублей события (ack load при уже готовом воркере — не событие). */
  private markReady(): void {
    if (this.stateValue !== 'ready') {
      this.setState('ready');
    }
  }

  // --- внутреннее: жизненный цикл процесса ---

  /**
   * Готовый процесс для операции (§15): живой — его гейт; рестарт в полёте —
   * гейт рестарта; иначе (первый запуск или после failed) — свежий spawn с
   * чистым счётчиком крашей (полная новая попытка — интерпретация §20).
   */
  private async ensureAlive(): Promise<AliveProcess> {
    if (this.disposed) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw disposedError();
    }
    if (this.alive !== undefined) {
      await this.alive.readyPromise;
      return this.alive;
    }
    if (this.restartGate !== undefined) {
      return this.restartGate;
    }
    this.spawnProcess(true);
    // currentAlive() (не this.alive напрямую): метод сбрасывает сужение типа
    // после ветки `this.alive !== undefined` выше (spawnProcess его заполняет).
    const alive = this.currentAlive();
    if (alive === undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw disposedError();
    }
    await alive.readyPromise;
    return alive;
  }

  /** Чтение alive без сужения потока управления (см. ensureAlive). */
  private currentAlive(): AliveProcess | undefined {
    return this.alive;
  }

  /**
   * Spawn (§5): статус starting, проводка порта/guard'а/exit; авто-reload —
   * см. шапку (§13). resetCrashes=true — spawn вне цепочки перезапуска.
   */
  private spawnProcess(resetCrashes: boolean): void {
    if (resetCrashes) {
      this.consecutiveCrashes = 0;
    }
    this.setState('starting');
    let handle: LlmWorkerProcess;
    try {
      handle = this.spawn(this.entryPath);
    } catch (cause) {
      // Системный отказ фабрики — без цикла перезапусков (см. шапку «ОШИБКИ»).
      this.logger.error('llm-worker: spawn не удался', { cause });
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент sqlite.ts)
      throw AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'llm-worker-spawn' }, cause);
    }
    let readyResolve!: () => void;
    let readyReject!: (error: AppError) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const alive: AliveProcess = {
      handle,
      readyPromise,
      readyReject,
      readinessDone: false,
      disposeKill: false,
    };
    this.alive = alive;
    handle.port.onMessage((message) => {
      this.onWorkerMessage(alive, message);
    });
    handle.onExit((code) => {
      this.onProcessExit(alive, code);
    });
    handle.port.start();
    this.logger.info('llm-worker: процесс запущен', { serviceName: 'llm-worker' });

    if (this.lastModelPath !== undefined) {
      // §13: воркер после краша теряет модель — клиент переотправляет load сам;
      // гейт закроется ack'ом (генерации дождутся, см. шапку).
      const modelPath = this.lastModelPath;
      const pending = this.createPendingCall();
      this.pendingCall = {
        ...pending,
        resolve: () => {
          alive.readinessDone = true;
          readyResolve();
          pending.resolve();
          this.markReady();
        },
        reject: (error) => {
          alive.readinessDone = true;
          alive.readyReject(error);
          pending.reject(error);
        },
      };
      if (!this.send({ type: 'load', modelPath })) {
        // Защитная ветка (свежий порт не может быть мёртв, но гейт не вправе висеть):
        // гейт и слот получают терминальный отказ — операции не зависают (§7).
        const error = workerCrashedError('exit');
        alive.readinessDone = true;
        alive.readyReject(error);
        pending.reject(error);
        this.pendingCall = undefined;
      }
    } else {
      alive.readinessDone = true;
      readyResolve();
      this.markReady();
    }
  }

  /** Exit процесса (§13): отказ ожиданий, счётчик крашей, перезапуск/failed. */
  private onProcessExit(alive: AliveProcess, code: number): void {
    if (this.alive !== alive) {
      return; // уже заменён перезапуском
    }
    this.alive = undefined;
    this.clearIdleTimer();
    const wasDisposeKill = alive.disposeKill;
    if (!wasDisposeKill) {
      this.logger.error('llm-worker: процесс завершился аварийно', { code });
    }

    const crashedRequestId =
      this.active !== undefined && !this.active.settled ? this.active.requestId : undefined;
    if (!alive.readinessDone) {
      alive.readyReject(workerCrashedError(wasDisposeKill ? 'disposed' : 'exit'));
    }
    if (this.active !== undefined && !this.active.settled) {
      this.failGeneration(this.active, workerCrashedError('exit'), false);
    }
    if (this.pendingCall !== undefined) {
      const pending = this.pendingCall;
      this.pendingCall = undefined;
      pending.reject(workerCrashedError('exit'));
    }
    this.discardTokens();
    if (wasDisposeKill || this.disposed) {
      return; // dispose: перезапуска нет (§9)
    }

    this.consecutiveCrashes += 1;
    if (this.consecutiveCrashes > this.maxRestartAttempts) {
      // Бюджет §5 исчерпан — failed; спавнов без новых операций нет.
      this.logger.error('llm-worker: бюджет перезапусков исчерпан', {
        consecutiveCrashes: this.consecutiveCrashes,
      });
      this.setState('failed');
      return;
    }
    this.setState('restarting', crashedRequestId);
    this.scheduleRestart();
  }

  /** Перезапуск с backoff (§5): гейт операций — готовность НОВОГО процесса. */
  private scheduleRestart(): void {
    this.restartGate = new Promise<AliveProcess>((resolve, reject) => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.restartGate = undefined;
        try {
          this.spawnProcess(false);
        } catch (cause) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ гейта — AppError (не Error по построению, TASK-006)
          reject(
            cause instanceof AppError
              ? cause
              : AppError.of(
                  'APP/INTERNAL',
                  'errors.internal',
                  { reason: 'llm-worker-spawn' },
                  cause,
                ),
          );
          return;
        }
        const alive = this.alive;
        if (alive === undefined) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ гейта — AppError (не Error по построению, TASK-006)
          reject(disposedError());
          return;
        }
        void alive.readyPromise.then(
          () => resolve(alive),
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ гейта — AppError (не Error по построению, TASK-006)
          (error: AppError) => reject(error),
        );
      }, this.restartBackoffMs);
    });
  }

  // --- внутреннее: протокол ---

  /** Диспетчеризация ответов воркера — только через guard контракта (§14). */
  private onWorkerMessage(alive: AliveProcess, raw: unknown): void {
    if (this.alive !== alive) {
      this.logger.debug('llm-worker: сообщение устаревшего процесса проигнорировано');
      return;
    }
    if (!isWorkerResponse(raw)) {
      this.logger.warn('llm-worker: сообщение канала не прошло guard — проигнорировано');
      return;
    }
    switch (raw.type) {
      case 'ready':
      case 'unloaded': {
        const pending = this.pendingCall;
        if (pending !== undefined) {
          this.pendingCall = undefined;
          pending.resolve();
        }
        this.markReady();
        return;
      }
      case 'token': {
        const generation = this.active;
        if (
          generation === undefined ||
          generation.settled ||
          generation.requestId !== raw.requestId
        ) {
          return; // поздний токен чужой/завершённой генерации — игнор
        }
        this.resetIdleTimer();
        this.tokenBuffer += raw.delta;
        if (this.flushTimer === undefined) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flushTokens();
          }, this.tokenFlushMs);
        }
        return;
      }
      case 'done': {
        const generation = this.active;
        if (
          generation === undefined ||
          generation.settled ||
          generation.requestId !== raw.requestId
        ) {
          return;
        }
        this.finishGeneration(generation, raw.finishReason, true);
        return;
      }
      case 'error': {
        if (raw.requestId !== undefined) {
          const generation = this.active;
          if (
            generation !== undefined &&
            !generation.settled &&
            generation.requestId === raw.requestId
          ) {
            this.failGeneration(generation, toAppError(raw.code), true);
          }
          return;
        }
        // Глобальная ошибка: незакрытый load/unload; иначе — лог (§18).
        const pending = this.pendingCall;
        if (pending !== undefined) {
          this.pendingCall = undefined;
          pending.reject(toAppError(raw.code));
        } else {
          this.logger.warn('llm-worker: глобальная ошибка без ожидающего', { code: raw.code });
        }
        return;
      }
    }
  }

  /** Слот ожидания load/unload: done + парные resolve/reject. */
  private createPendingCall(): PendingCall {
    let resolve!: () => void;
    let reject!: (error: AppError) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { done, resolve, reject };
  }

  // --- внутреннее: генерация и стрим ---

  /**
   * Завершение генерации (done/cancelled): дочистка буфера ДО резолва (§11);
   * УСПЕШНО завершённая генерация — воркер доказал живучесть: счётчик «подряд»
   * крашей обнуляется (интерпретация §5: подряд = без успешной генерации между).
   */
  private finishGeneration(
    generation: ActiveGeneration,
    finishReason: LlmFinishReason,
    notifyReady: boolean,
  ): void {
    if (generation.settled) {
      return;
    }
    generation.settled = true;
    this.clearIdleTimer();
    this.flushTokens();
    if (this.active === generation) {
      this.active = undefined;
    }
    generation.resolvers.resolve({ finishReason });
    this.consecutiveCrashes = 0;
    if (notifyReady) {
      this.setState('ready', generation.requestId);
    }
  }

  /** Отказ генерации (BUSY / ENGINE_* / CRASHED): буфер отбрасывается (не ответ). */
  private failGeneration(
    generation: ActiveGeneration,
    error: AppError,
    notifyReady: boolean,
  ): void {
    if (generation.settled) {
      return;
    }
    generation.settled = true;
    this.clearIdleTimer();
    this.discardTokens();
    if (this.active === generation) {
      this.active = undefined;
    }
    generation.resolvers.reject(error);
    if (notifyReady) {
      this.setState('ready', generation.requestId);
    }
  }

  /** Пачка токенов подписчику и renderer'у (§11; отказ моста не рвёт стрим). */
  private flushTokens(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.tokenBuffer === '') {
      return;
    }
    const generation = this.active;
    const text = this.tokenBuffer;
    this.tokenBuffer = '';
    if (generation === undefined) {
      return;
    }
    if (generation.handlers?.onToken !== undefined) {
      try {
        generation.handlers.onToken(text);
      } catch (cause) {
        this.logger.warn('llm-worker: onToken потребителя упал — стрим продолжается', { cause });
      }
    }
    try {
      this.notify('ai:token', { requestId: generation.requestId, text });
    } catch (cause) {
      this.logger.debug('llm-worker: ai:token не доставлен', {
        requestId: generation.requestId,
        cause,
      });
    }
  }

  private discardTokens(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.tokenBuffer = '';
  }

  // --- внутреннее: watchdog (§22) ---

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.onIdleTimeout();
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** §22: генерация без токенов/done дольше idleTimeoutMs → kill + путь краша. */
  private onIdleTimeout(): void {
    const generation = this.active;
    if (generation === undefined || generation.settled) {
      return;
    }
    this.logger.warn('llm-worker: watchdog — нет отклика, процесс будет перезапущен', {
      requestId: generation.requestId,
      idleTimeoutMs: this.idleTimeoutMs,
    });
    this.failGeneration(generation, workerCrashedError('idle-watchdog'), false);
    this.alive?.handle.kill();
  }

  // --- внутреннее: отправка ---

  /**
   * Отправка запроса воркеру. Возвращает false, если доставки НЕ было: процесса
   * нет (вызывающий код обязан дать операции терминальное состояние — §7, ревью
   * TASK-076) либо порт бросил (exit-путь подстрахует, повторного set'а не будет
   * — settled-флаги). Cancel-не-доставка не обрабатывается: cancel идемпотентен.
   */
  private send(message: WorkerRequest): boolean {
    const alive = this.alive;
    if (alive === undefined) {
      return false;
    }
    try {
      alive.handle.port.postMessage(message);
      return true;
    } catch (cause) {
      this.logger.warn('llm-worker: запрос не отправлен (порт закрыт?)', {
        type: message.type,
        cause,
      });
      return false;
    }
  }
}
