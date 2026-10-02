/**
 * Публичный API модуля privacy пакета @hl/contracts (TASK-098): схемы каналов
 * `privacy/journal|consents`, DTO журнала/операций/согласий и выведенные типы.
 * Renderer (экран «Приватность», TASK-099) импортирует формы отсюда (арх. 03 §4 —
 * разрешённая зависимость renderer); main — реестр CHANNEL_SCHEMAS.
 */
export {
  NETWORK_EVENT_DTO_SCHEMA,
  NETWORK_EVENT_STATUS_SCHEMA,
  PRIVACY_CONSENTS_PATCH_SCHEMA,
  PRIVACY_CONSENTS_REQUEST_SCHEMA,
  PRIVACY_CONSENTS_RESPONSE_SCHEMA,
  PRIVACY_JOURNAL_REQUEST_SCHEMA,
  PRIVACY_JOURNAL_RESPONSE_SCHEMA,
  PRIVACY_OPERATION_SCHEMA,
} from './schemas.js';
export type {
  Consents,
  NetworkEventDto,
  NetworkEventStatusDto,
  OperationInfo,
  PrivacyConsentsPatch,
  PrivacyConsentsRequest,
  PrivacyConsentsResponse,
  PrivacyJournalRequest,
  PrivacyJournalResponse,
} from './schemas.js';
