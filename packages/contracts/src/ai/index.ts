/**
 * TASK-076 §6: публичный API контрактов ИИ-воркера — MessagePort-протокол
 * llm-worker (UtilityProcess). Потребители: main-клиент LlmProcessClient (076),
 * воркер llm-worker/main.ts, движок 077; renderer протокол НЕ видит (только
 * события ai:status/ai:token из events.ts).
 */
/**
 * TASK-080 §6: контракты витрины моделей — статусы загрузки (ModelStatus),
 * форма статуса (ModelStatusInfo), payload ai:progress (ModelProgressPayload),
 * паттерн имени файла (MODEL_FILE_PATTERN, §14).
 */
export {
  MODEL_FILE_PATTERN,
  MODEL_STATUSES,
  type ModelProgressPayload,
  type ModelStatus,
  type ModelStatusInfo,
} from './models.js';

export {
  KNOWN_WORKER_ERROR_CODES,
  isWorkerRequest,
  isWorkerResponse,
  type ChatMessage,
  type ChatRole,
  type GenerationParams,
  type LlmFinishReason,
  type WorkerCancelRequest,
  type WorkerCompleteRequest,
  type WorkerErrorCode,
  type WorkerErrorResponse,
  type WorkerLoadRequest,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerDoneResponse,
  type WorkerReadyResponse,
  type WorkerTokenResponse,
  type WorkerUnloadRequest,
  type WorkerUnloadedResponse,
} from './worker-protocol.js';
