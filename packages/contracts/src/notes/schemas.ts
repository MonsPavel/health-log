/**
 * TASK-045 §5/§11: zod-схемы канала `notes/search` — FTS-поиск заметок (FR-2.2,
 * арх. 05 §3). Запрос: {query: string ≤100, limit?: int 1–200 с дефолтом 50};
 * ответ: {items: MeasurementDto[]}. Объекты .strict() (§14: IPC-гигиена TASK-008).
 *
 * query — ЛЮБАЯ строка ≤100 (включая пустую и «мусорную»): осмысленность ввода
 * решает use case (§11: мусорный запрос → пустой результат, не ошибка; ошибки
 * канала — только APP/INTERNAL). Максимум длины — DoS-гигиена (§7/§14).
 *
 * limit: дефолт 50 (§2/§13 — страница поиска; UI предупреждает об усечении при
 * равенстве), максимум 200 (§11). Валидация по нижней границе 1 — отрицательные
 * и нулевой лимиты в поиске смысла не имеют (каркас вернёт VALIDATION/FAILED).
 */
import { z } from 'zod';

import { MEASUREMENT_DTO_SCHEMA } from '../measurement/schemas.js';

/** §7/§14: максимум длины запроса — анти-DoS от себя (решение §7). */
export const NOTES_QUERY_MAX_LENGTH = 100;

/** §2/§13: дефолт страницы поиска. */
export const NOTES_SEARCH_DEFAULT_LIMIT = 50;

/** §11: максимум страницы поиска. */
export const NOTES_SEARCH_MAX_LIMIT = 200;

/** §11: запрос notes/search. */
export const NOTES_SEARCH_REQUEST_SCHEMA = z
  .object({
    query: z.string().max(NOTES_QUERY_MAX_LENGTH),
    limit: z
      .number()
      .int()
      .min(1)
      .max(NOTES_SEARCH_MAX_LIMIT)
      .default(NOTES_SEARCH_DEFAULT_LIMIT),
  })
  .strict();

/** §11: ответ notes/search — тот же список записей, что у журнала (§5: MeasurementDto[]). */
export const NOTES_SEARCH_RESPONSE_SCHEMA = z
  .object({ items: z.array(MEASUREMENT_DTO_SCHEMA) })
  .strict();
