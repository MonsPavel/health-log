/**
 * TASK-078 §5/§9: ProcessLlmEngine — ТОНКАЯ обёртка клиента llm-worker
 * (LlmProcessClient, TASK-076) за application-портом LlmEngine. Вся логика
 * жизненного цикла (spawn/handshake/краш-перезапуски/watchdog/BUSY-гварды)
 * остаётся в клиенте 076; здесь — только трансляция форм:
 *  - client.complete(requestId, …, {onToken}) → AsyncIterable {delta}|{done}
 *    (контракт доставки ошибок/финала — порт llm-engine.ts: отказ промиса
 *    клиента, включая AI/BUSY и AI/WORKER_CRASHED, — первым шагом итерации);
 *  - request.signal (abort) → client.cancel(requestId): реальный воркер
 *    остановит стрим и закроет done(cancelled) — единообразие §13;
 *  - cancel() порт-метод → cancel(requestId) АКТИВНОЙ генерации этой обёртки
 *    (порт без requestId — движок держит один слот генерации, §5 076); разрыв
 *    потока потребителем (break/return) генерацию НЕ отменяет — как у реального
 *    стрима (AsyncGenerator.return() не может прервать never-settling await
 *    очереди; завершение — signal запроса или cancel(), контракт порта);
 *  - ensureModel(modelId) → client.load(modelId), идемпотентно (§19): тот же
 *    id — no-op; отказ load не фиксирует модель (ретри следующим вызовом);
 *  - status() → EngineStatus §7: busy — по состоянию клиента ('busy'),
 *    loaded/modelId — по факту успешного ensureModel (после краша клиент 076
 *    авто-reload'ит модель сам — обёртка остаётся «тонкой» и не дублирует это).
 *
 * maxTokens (§5: в запросе порта нет): деталь адаптера — опция, дефолт 512
 * (TD-IMP реестра: резюме/чат помещаются; точная настройка — за use case'ами
 * 087+ через параметры порта, если потребуется).
 *
 * ГОТОВНОСТЬ К ПОДМЕНЕ (§19): зависимость — структурная поверхность
 * LlmEngineProcessClient (публичные методы LlmProcessClient) — юнит-тесты
 * подставляют fake; контейнер передаёт боевой клиент. requestId генераций —
 * локальный счётчик `llm-engine-<n>` (стрим-события ai:token/ai:status
 * renderer'а продолжают адресоваться по нему, §11 076).
 */
import type { AiWorkerState } from '@hl/contracts';
import type { AppError } from '@hl/kernel';

import type {
  LlmCompleteHandlers,
  LlmCompleteRequest,
  LlmCompleteResult,
} from './llm-process-client.js';
import {
  type EngineStatus,
  type LlmEngine,
  type LlmEngineChunk,
  type LlmEngineRequest,
} from '../application/ports/llm-engine.js';

/** Дефолт maxTokens генерации (см. шапку). */
const DEFAULT_MAX_TOKENS = 512;

/** Причина завершения генерации (контракт 076): stop | cancelled. */
type LlmFinishReason = LlmCompleteResult['finishReason'];

/**
 * Поверхность клиента 076, нужная адаптеру (§19: структурная — тесты подменяют
 * fake-клиентом; боевой LlmProcessClient удовлетворяет ей публичными методами).
 */
export interface LlmEngineProcessClient {
  /** Состояние воркера (ai:status 076) — источник busy статуса движка. */
  readonly state: AiWorkerState;
  load(modelPath: string): Promise<void>;
  complete(
    requestId: string,
    request: LlmCompleteRequest,
    handlers?: LlmCompleteHandlers,
  ): Promise<LlmCompleteResult>;
  cancel(requestId: string): void;
}

/** Опции адаптера (§5: тонкая — зависимость одна, maxTokens переопределяем). */
export interface ProcessLlmEngineOptions {
  /** Боевой клиент llm-worker (контейнер) или fake (тесты §19). */
  readonly client: LlmEngineProcessClient;
  /** maxTokens генерации; по умолчанию 512 (см. шапку). */
  readonly maxTokens?: number;
}

/**
 * Очередь чанков стрима (мост «колбэк onToken + промис» клиента → AsyncIterable):
 * токены копятся до финала, порядок сохраняется; terminate/fail будят ожидающий
 * next(). После terminated новые push игнорируются (поздние токены чужого финала).
 */
class EngineChunkQueue {
  private readonly pending: LlmEngineChunk[] = [];
  private waiting: Array<() => void> = [];
  private finished: LlmFinishReason | undefined;
  private failure: AppError | undefined;
  private terminated = false;

  /** Токен-пачка от клиента (§11 076 — пачками; здесь каждая пачка — одна дельта). */
  pushDelta(text: string): void {
    if (this.terminated) {
      return; // финал уже доставлен/отказ — поздний токен не идёт в поток
    }
    this.pending.push({ delta: text });
    this.wake();
  }

  /** Успешный финал (done|cancelled по промису клиента). */
  finish(reason: LlmFinishReason): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.finished = reason;
    this.wake();
  }

  /** Отказ клиента (AppError по построению 076) — первый шаг итерации бросит его. */
  fail(error: AppError): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.failure = error;
    this.wake();
  }

  /** Поток-потребитель: дельты по порядку, финал последним чанком, отказ — throw. */
  async *stream(): AsyncIterableIterator<LlmEngineChunk> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.failure !== undefined) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок порта — AppError (TASK-006; прецедент llm-process-client)
        throw this.failure;
      }
      if (this.finished !== undefined) {
        yield { done: this.finished };
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
  }

  private wake(): void {
    const resolvers = this.waiting;
    this.waiting = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

/**
 * Реальный движок за клиентом llm-worker (§5 «ProcessLlmEngine — обёртка
 * клиента 076 — тонкая»). Реализует порт LlmEngine.
 */
export class ProcessLlmEngine implements LlmEngine {
  private readonly processClient: LlmEngineProcessClient;
  private readonly maxTokens: number;

  private modelId: string | undefined;
  /** requestId последней СТАРТОВАННОЙ обёрткой генерации (для cancel() порта). */
  private activeRequestId: string | undefined;
  private requestCounter = 0;

  constructor(options: ProcessLlmEngineOptions) {
    this.processClient = options.client;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * Клиент 076 под обёрткой: контейнер-тесты фиксируют проводку (обёртка над
   * ТЕМ ЖЕ синглтоном графа, container-llm-engine.int.test.ts), TASK-088 сможет
   * мостить статусы ai:status без новых зависимостей.
   */
  get client(): LlmEngineProcessClient {
    return this.processClient;
  }

  /** Идемпотентная загрузка модели (§19): тот же id — no-op; отказ — не фиксирует. */
  async ensureModel(modelId: string): Promise<void> {
    if (this.modelId === modelId) {
      return;
    }
    await this.processClient.load(modelId);
    this.modelId = modelId;
  }

  /** Статус (§7): busy — состояние клиента; loaded/modelId — успешный ensureModel. */
  status(): EngineStatus {
    return {
      loaded: this.modelId !== undefined,
      modelId: this.modelId,
      busy: this.processClient.state === 'busy',
    };
  }

  /** Отмена активной генерации этой обёртки (без сигнала); идемпотентна. */
  cancel(): void {
    if (this.activeRequestId !== undefined) {
      this.processClient.cancel(this.activeRequestId);
    }
  }

  /** Генерация (ленивый AsyncIterable — контракт доставки в шапке порта). */
  complete(request: LlmEngineRequest): AsyncIterable<LlmEngineChunk> {
    return this.generate(request);
  }

  private async *generate(request: LlmEngineRequest): AsyncIterableIterator<LlmEngineChunk> {
    if (request.signal.aborted) {
      // §13: abort до старта — немедленный done(cancelled), клиент не зовётся.
      yield { done: 'cancelled' };
      return;
    }

    const requestId = `llm-engine-${(this.requestCounter += 1)}`;
    this.activeRequestId = requestId;
    const queue = new EngineChunkQueue();
    const onAbort = (): void => {
      // Реальный воркер остановит стрим и закроет done(cancelled) (§13 076).
      this.processClient.cancel(requestId);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    const run = this.processClient.complete(
      requestId,
      { messages: request.messages, params: request.params, maxTokens: this.maxTokens },
      { onToken: (text) => queue.pushDelta(text) },
    );
    void run.then(
      (result) => {
        this.clearActive(requestId);
        request.signal.removeEventListener('abort', onAbort);
        queue.finish(result.finishReason);
      },
      // Отказ промиса клиента — AppError по построению 076 (контракт TASK-006).
      (error: AppError) => {
        this.clearActive(requestId);
        request.signal.removeEventListener('abort', onAbort);
        queue.fail(error);
      },
    );

    // Разрыв потребителем (break/return) не отменяет генерацию — контракт порта
    // (см. шапку): return() на приостановке await не завершится, пока очередь не
    // разбудит финал; завершать генерацию обязан потребитель (signal/cancel).
    yield* queue.stream();
  }

  private clearActive(requestId: string): void {
    if (this.activeRequestId === requestId) {
      this.activeRequestId = undefined;
    }
  }
}
