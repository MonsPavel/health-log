/**
 * Публичный API модуля prefs пакета @hl/contracts (TASK-047): схемы каналов
 * `prefs/get|set`, документ Prefs/patch и выведенные типы. Renderer импортирует
 * формы и схемы отсюда (арх. 03 §4 — разрешённая зависимость renderer), main —
 * реестр CHANNEL_SCHEMAS и PREFS_PATCH_SCHEMA сервиса.
 */
export {
  DATE_FORMAT_SCHEMA,
  NET_CONSENTS_SCHEMA,
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_GET_RESPONSE_SCHEMA,
  PREFS_PATCH_SCHEMA,
  PREFS_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
  PREFS_SET_RESPONSE_SCHEMA,
  TEXT_SCALE_SCHEMA,
  THEME_SCHEMA,
} from './schemas.js';
export type { NetConsents, Prefs, PrefsPatch } from './types.js';
