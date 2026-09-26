/**
 * TASK-028 §5/§23: типы каналов измерений выводятся из zod-схем (z.infer) —
 * никакой ручной синхронизации. Потребители: use cases TASK-029/030/037 (main),
 * форма и список TASK-031/033 (renderer — разрешённая зависимость, §10).
 */
import type { z } from 'zod';

import type {
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

/** Запрос add (§11): MeasurementAddRequest. */
export type MeasurementAddRequest = z.infer<typeof MEASUREMENT_ADD_REQUEST_SCHEMA>;

/** Флаги эвристик ответа add (§5): {typo?, duplicate?, criticalValue?}. */
export type MeasurementFlags = z.infer<typeof MEASUREMENT_FLAGS_SCHEMA>;

/** Сигнал «вероятная опечатка» — зеркало TypoFlag (TASK-018). */
export type TypoFlagDto = z.infer<typeof MEASUREMENT_TYPO_FLAG_SCHEMA>;

/** Плоская форма агрегата BpMeasurement (§7): DTO ≠ агрегат, маппинг — в main. */
export type MeasurementDto = z.infer<typeof MEASUREMENT_DTO_SCHEMA>;

/** Ответ add (§11): {measurement, flags}. */
export type MeasurementAddResponse = z.infer<typeof MEASUREMENT_ADD_RESPONSE_SCHEMA>;

/** Запрос list (§11): query из TASK-021-порта; limit/offset обязательны после дефолтов. */
export type MeasurementListRequest = z.infer<typeof MEASUREMENT_LIST_REQUEST_SCHEMA>;

/** Ответ list (§11): {items, total}. */
export type MeasurementListResponse = z.infer<typeof MEASUREMENT_LIST_RESPONSE_SCHEMA>;

/** Запрос update (§11): {id, …поля add}. */
export type MeasurementUpdateRequest = z.infer<typeof MEASUREMENT_UPDATE_REQUEST_SCHEMA>;

/** Ответ update (§11): {measurement}. */
export type MeasurementUpdateResponse = z.infer<typeof MEASUREMENT_UPDATE_RESPONSE_SCHEMA>;

/** Запрос delete (§11): {id}. */
export type MeasurementDeleteRequest = z.infer<typeof MEASUREMENT_DELETE_REQUEST_SCHEMA>;

/** Ответ delete (§11): {deleted: true}. */
export type MeasurementDeleteResponse = z.infer<typeof MEASUREMENT_DELETE_RESPONSE_SCHEMA>;
