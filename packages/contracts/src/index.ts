/**
 * Публичный API @hl/contracts (TASK-008): конверты IPC, DTO ошибок, реестр каналов,
 * транспортный контракт моста `hl` (арх. 05 §1: контракт первичен).
 */
export {
  API_ENVELOPE_VERSION,
  apiFailure,
  apiSuccess,
  isApiEnvelope,
  type ApiEnvelope,
  type ApiFailure,
  type ApiResult,
  type ApiSuccess,
} from './api-result.js';
export {
  APP_INTERNAL_ERROR,
  VALIDATION_FAILED_ERROR,
  toDto,
  type AppErrorDto,
} from './app-error-dto.js';
export {
  HL_INVOKE_CHANNEL,
  HL_INVOKE_REQUEST_SCHEMA,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type HlBridge,
} from './channels.js';
export { CHANNEL_SCHEMAS, type ChannelSchemas } from './schemas.js';
