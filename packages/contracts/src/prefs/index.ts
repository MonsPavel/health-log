/**
 * Публичный API модуля prefs пакета @hl/contracts (TASK-047): схемы каналов
 * `prefs/get|set`, документ Prefs/patch и выведенные типы. Renderer импортирует
 * формы и схемы отсюда (арх. 03 §4 — разрешённая зависимость renderer), main —
 * реестр CHANNEL_SCHEMAS и PREFS_PATCH_SCHEMA сервиса.
 */
export {
  AI_SETTINGS_SCHEMA,
  DATE_FORMAT_SCHEMA,
  JOB_LAST_BACKUP_SCHEMA,
  JOB_STATE_SCHEMA,
  NET_CONSENTS_SCHEMA,
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_GET_RESPONSE_SCHEMA,
  PREFS_PATCH_SCHEMA,
  PREFS_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
  PREFS_SET_RESPONSE_SCHEMA,
  TEXT_SCALE_SCHEMA,
  THEME_SCHEMA,
  UPDATE_CHANNEL_SCHEMA,
} from './schemas.js';
export type {
  AiSettings,
  JobLastBackup,
  JobState,
  NetConsents,
  Prefs,
  PrefsGetRequest,
  PrefsGetResponse,
  PrefsPatch,
  PrefsSetRequest,
  PrefsSetResponse,
  UpdateChannel,
} from './types.js';
