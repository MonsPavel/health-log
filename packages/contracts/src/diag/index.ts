/**
 * Публичный API модуля diag пакета @hl/contracts (TASK-103): схемы каналов
 * `diag/preview|save`, форма предпросмотра DiagContent, манифест пакета и
 * выведенные типы. Renderer (секция «Диагностика», TASK-103 §10) импортирует
 * формы отсюда (арх. 03 §4 — разрешённая зависимость renderer).
 */
export {
  DIAG_CONTENT_SCHEMA,
  DIAG_FILE_SCHEMA,
  DIAG_MANIFEST_SCHEMA,
  DIAG_PREVIEW_REQUEST_SCHEMA,
  DIAG_PREVIEW_RESPONSE_SCHEMA,
  DIAG_SAVE_REQUEST_SCHEMA,
  DIAG_SAVE_RESPONSE_SCHEMA,
} from './schemas.js';
export type {
  DiagContent,
  DiagFile,
  DiagManifest,
  DiagPreviewRequest,
  DiagPreviewResponse,
  DiagSaveRequest,
  DiagSaveResponse,
} from './schemas.js';
