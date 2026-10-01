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

/**
 * TASK-081 §5/§7/§11: контракты каналов витрины моделей ai/models/* — экран
 * «Модель» (/ai): list одним вызовом (ModelView + ramTotalGb + uiLanguage),
 * download/pause/resume/reset {modelId} → статус, select {modelId} → prefs.
 */
export {
  AI_MODELS_DOWNLOAD_REQUEST_SCHEMA,
  AI_MODELS_LIST_REQUEST_SCHEMA,
  AI_MODELS_LIST_RESPONSE_SCHEMA,
  AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
  AI_MODELS_PAUSE_RESPONSE_SCHEMA,
  AI_MODELS_RESET_RESPONSE_SCHEMA,
  AI_MODELS_SELECT_RESPONSE_SCHEMA,
  AI_MODELS_RESUME_RESPONSE_SCHEMA,
  AI_MODELS_STATUS_RESPONSE_SCHEMA,
  MODEL_VIEW_SCHEMA,
  type AiModelsListRequest,
  type AiModelsListResponse,
  type AiModelsModelIdRequest,
  type AiModelsSelectResponse,
  type ModelView,
} from './models-channels.js';

/**
 * TASK-083 §5/§11: контракт канала превью ИИ-контекста — {profileId, period,
 * includeNotes} → {text, sections, hash}; EN-идентификаторы секций — общий
 * контракт сборщика и UI (§10/§17: маркеры EN, подписи RU).
 */
export {
  AI_CONTEXT_PREVIEW_REQUEST_SCHEMA,
  AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA,
  AI_CONTEXT_SECTION_IDS,
  AI_CONTEXT_SECTION_SCHEMA,
  type AiContextPreviewRequest,
  type AiContextPreviewResponse,
  type AiContextSectionId,
} from './context-channels.js';

export {
  AI_CANCEL_REQUEST_SCHEMA,
  AI_CANCEL_RESPONSE_SCHEMA,
  AI_SUMMARY_DELETE_ALL_REQUEST_SCHEMA,
  AI_SUMMARY_DELETE_ALL_RESPONSE_SCHEMA,
  AI_SUMMARY_DTO_SCHEMA,
  AI_SUMMARY_GENERATE_REQUEST_SCHEMA,
  AI_SUMMARY_GENERATE_RESPONSE_SCHEMA,
  AI_SUMMARY_LATEST_REQUEST_SCHEMA,
  AI_SUMMARY_LATEST_RESPONSE_SCHEMA,
  type AiCancelRequest,
  type AiCancelResponse,
  type AiSummaryDeleteAllRequest,
  type AiSummaryDeleteAllResponse,
  type AiSummaryDto,
  type AiSummaryGenerateRequest,
  type AiSummaryGenerateResponse,
  type AiSummaryLatestRequest,
  type AiSummaryLatestResponse,
} from './summary-channels.js';

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
