/**
 * TASK-076 §5/§6: каркас llm-worker — цикл сообщений MessagePort-протокола,
 * реестр активных генераций и порт движка LlmWorkerEngine.
 *
 * РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ (прецедент workerpool TASK-066):
 *  - wire-формы и runtime-guard'ы — @hl/contracts (ai/worker-protocol): единый
 *    источник для клиента main-стороны и воркера;
 *  - здесь — только исполнение протокола: диспетчеризация запросов, реестр
 *    одновременных генераций (одна, §5 «не включено»: второй complete → error
 *    BUSY), мост ответов движка в wire-сообщения.
 *
 * ПОРТ ДВИЖКА (§5 «мост для 077»): движок внедряется — TASK-077 подключит
 * llama.cpp за тем же интерфейсом, тесты подставляют fake/заглушку. Заглушка
 * notConfiguredEngine отвечает кодом ENGINE_NOT_CONFIGURED на всё — процесс
 * и протокол живут и до реального движка.
 *
 * ОШИБКИ (§13): отказ движка конвертируется в адресный (с requestId) или
 * глобальный error воркера — наружу код-строка (workerErrorCode у EngineError,
 * прочее → 'UNKNOWN'); детали остаются в воркере (§14: наружу только коды).
 * Движок решает, как завершить отмену: cancel лишь доставляется — поток закроет
 * done(cancelled) сам.
 *
 * БЕЗОПАСНОСТЬ (§14): запросы проходят guard контракта (isWorkerRequest) —
 * повреждённый канал не управляет процессом; воркер не знает про БД/ключи/сеть
 * (§8): в него входит только путь модели параметром load.
 *
 * ОТКАЗ ПОРТА (§9): postMessage мёртвого порта глушится — main увидит краш по
 * exit процесса и перезапустит воркера; воркер не может «спасти» мёртвый канал.
 */
import {
  isWorkerRequest,
  type ChatMessage,
  type GenerationParams,
  type LlmFinishReason,
  type WorkerRequest,
  type WorkerResponse,
} from '@hl/contracts';

/** Известные каркасу коды ошибок воркера (см. также KNOWN_WORKER_ERROR_CODES в contracts). */
export const WORKER_ERROR = {
  /** Вторая параллельная генерация; load/unload при активной (§9/§20/§23). */
  BUSY: 'BUSY',
  /** Заглушка движка до TASK-077 (§5 «engine: not-configured»). */
  ENGINE_NOT_CONFIGURED: 'ENGINE_NOT_CONFIGURED',
  /** Неопознанный отказ движка (наружу код, не текст — §14). */
  UNKNOWN: 'UNKNOWN',
} as const;

/**
 * Ошибка движка с машинным кодом для wire-протокола (§13). Движок TASK-077
 * бросает её со своим кодом; прочие исключения уходят наружу как UNKNOWN.
 */
export class EngineError extends Error {
  /** Код для поля code ответа {type:'error'} (строка — реестр движка, §5). */
  readonly workerErrorCode: string;

  constructor(workerErrorCode: string, options?: { cause?: unknown }) {
    super(`движок llm-worker: ${workerErrorCode}`, options);
    this.name = 'EngineError';
    this.workerErrorCode = workerErrorCode;
  }
}

/** Параметры генерации на порту движка (форма complete-запроса без type-дискриминатора). */
export interface WorkerCompleteParams {
  readonly requestId: string;
  readonly messages: readonly ChatMessage[];
  readonly params?: GenerationParams;
  readonly maxTokens: number;
}

/**
 * Порт движка (§5 «мост для 077»): load/unload по пути модели, complete —
 * стрим через колбэк emit + promise причины завершения, cancel — кооперативный
 * сигнал (движок сам закроет complete с finishReason 'cancelled').
 */
export interface LlmWorkerEngine {
  load(modelPath: string): Promise<void>;
  unload(): Promise<void>;
  complete(request: WorkerCompleteParams, emit: (delta: string) => void): Promise<LlmFinishReason>;
  cancel(requestId: string): void;
}

/**
 * Транспорт воркера (переданный MessagePort): postMessage наружу, подписка на
 * запросы main. main.test.ts и воркер-глюк Electron (main.ts) дают адаптеры.
 */
export interface WorkerTransport {
  postMessage(message: WorkerResponse): void;
  onRequest(listener: (request: WorkerRequest) => void): void;
}

/** Заглушка движка (§5): всё — EngineError ENGINE_NOT_CONFIGURED (мост для 077). */
export const notConfiguredEngine: LlmWorkerEngine = {
  load: () => Promise.reject(engineNotConfigured()),
  unload: () => Promise.reject(engineNotConfigured()),
  complete: () => Promise.reject(engineNotConfigured()),
  cancel: () => undefined, // отменять нечего — идемпотентный no-op
};

/** Запускает цикл сообщений воркера над транспортом (§5 «loop сообщений»). */
export function startLlmWorkerLoop(transport: WorkerTransport, engine: LlmWorkerEngine): void {
  /** Реестр активных генераций (§5): одновременная — одна, второй complete → BUSY. */
  const active = new Set<string>();

  const reply = (message: WorkerResponse): void => {
    try {
      transport.postMessage(message);
    } catch {
      // Порт мёртв: воркер не может починить канал — main увидит exit и перезапустит.
    }
  };

  const dispatch = async (request: WorkerRequest): Promise<void> => {
    switch (request.type) {
      case 'load': {
        if (active.size > 0) {
          reply({ type: 'error', code: WORKER_ERROR.BUSY });
          return;
        }
        try {
          await engine.load(request.modelPath);
          reply({ type: 'ready' });
        } catch (cause) {
          reply({ type: 'error', code: toWireCode(cause) });
        }
        return;
      }
      case 'unload': {
        if (active.size > 0) {
          // Выгрузка во время генерации сломала бы поток токенов (§20).
          reply({ type: 'error', code: WORKER_ERROR.BUSY });
          return;
        }
        try {
          await engine.unload();
          reply({ type: 'unloaded' });
        } catch (cause) {
          reply({ type: 'error', code: toWireCode(cause) });
        }
        return;
      }
      case 'complete': {
        if (active.size > 0) {
          // Очереди нет (§5 «не включено») — UI блокирует кнопку по AI/BUSY клиента.
          reply({ type: 'error', requestId: request.requestId, code: WORKER_ERROR.BUSY });
          return;
        }
        active.add(request.requestId);
        try {
          const finishReason = await engine.complete(request, (delta) => {
            reply({ type: 'token', requestId: request.requestId, delta });
          });
          active.delete(request.requestId);
          reply({ type: 'done', requestId: request.requestId, finishReason });
        } catch (cause) {
          active.delete(request.requestId);
          reply({ type: 'error', requestId: request.requestId, code: toWireCode(cause) });
        }
        return;
      }
      case 'cancel': {
        // Идемпотентность (§13): незнакомый requestId — тихий игнор.
        if (active.has(request.requestId)) {
          engine.cancel(request.requestId);
        }
        return;
      }
    }
  };

  transport.onRequest((raw) => {
    // Guard контракта (§14): повреждённый/чужой канал не управляет процессом.
    if (!isWorkerRequest(raw)) {
      return;
    }
    void dispatch(raw);
  });
}

/** Отказ движка → код wire-ответа (EngineError — его код, прочее — UNKNOWN, §14). */
function toWireCode(cause: unknown): string {
  return cause instanceof EngineError ? cause.workerErrorCode : WORKER_ERROR.UNKNOWN;
}

function engineNotConfigured(): EngineError {
  return new EngineError(WORKER_ERROR.ENGINE_NOT_CONFIGURED);
}
