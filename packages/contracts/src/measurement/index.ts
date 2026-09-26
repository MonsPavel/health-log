/**
 * Публичный API модуля measurement пакета @hl/contracts (TASK-028): схемы каналов
 * `measurements/*` и выведенные из них типы. Renderer импортирует формы и схемы
 * отсюда (арх. 03 §4 — разрешённая зависимость renderer), main — реестр CHANNEL_SCHEMAS.
 */
export {
  MEASUREMENT_ADD_REQUEST_SCHEMA,
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  MEASUREMENT_DELETE_REQUEST_SCHEMA,
  MEASUREMENT_DELETE_RESPONSE_SCHEMA,
  MEASUREMENT_DTO_SCHEMA,
  MEASUREMENT_FLAGS_SCHEMA,
  MEASUREMENT_LIST_REQUEST_SCHEMA,
  MEASUREMENT_LIST_RESPONSE_SCHEMA,
  MEASUREMENT_TYPO_FLAG_SCHEMA,
  MEASUREMENT_UPDATE_REQUEST_SCHEMA,
  MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
} from './schemas.js';
export type {
  MeasurementAddRequest,
  MeasurementAddResponse,
  MeasurementDeleteRequest,
  MeasurementDeleteResponse,
  MeasurementDto,
  MeasurementFlags,
  MeasurementListRequest,
  MeasurementListResponse,
  MeasurementUpdateRequest,
  MeasurementUpdateResponse,
  TypoFlagDto,
} from './types.js';
