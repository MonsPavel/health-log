/**
 * TASK-054 §23: типы канала `stats/period` выводятся из zod-схем (z.infer) — никакой
 * ручной синхронизации. Потребители: GetPeriodStatistics (use case main, TASK-054),
 * дашборд (TASK-061), отчёт (TASK-068), ИИ-контекст (TASK-083); период — также
 * TASK-056 (trend/series, §23: переиспользование схемы обязательно).
 */
import type { z } from 'zod';

import type {
  PERIOD_STATISTICS_DTO_SCHEMA,
  STATS_CLASSIFICATION_NOTE_SCHEMA,
  STATS_CLASSIFICATION_SCHEMA,
  STATS_PART_STATS_SCHEMA,
  STATS_PERIOD_PARAM_SCHEMA,
  STATS_REQUEST_SCHEMA,
  STATS_RESPONSE_SCHEMA,
  STATS_SCALE_INFO_SCHEMA,
  STATS_VALUE_STATS_SCHEMA,
} from './schemas.js';

/** Период канала (§5): пресет TASK-044 или custom-границы TASK-046 (включительно). */
export type StatsPeriodParam = z.infer<typeof STATS_PERIOD_PARAM_SCHEMA>;

/** Агрегаты одного канала значений (052 §7). */
export type StatsValueStats = z.infer<typeof STATS_VALUE_STATS_SCHEMA>;

/** Часть суток (052 §7). */
export type StatsPartStats = z.infer<typeof STATS_PART_STATS_SCHEMA>;

/** Примечание классификации 053. */
export type StatsClassificationNote = z.infer<typeof STATS_CLASSIFICATION_NOTE_SCHEMA>;

/** Классификация средних 053 (категория опциональна — EC-09). */
export type StatsClassification = z.infer<typeof STATS_CLASSIFICATION_SCHEMA>;

/** Read model периода на проводе (§7): плоская форма 052 + classification 053. */
export type PeriodStatisticsDto = z.infer<typeof PERIOD_STATISTICS_DTO_SCHEMA>;

/** Справка об активной шкале (§4). */
export type StatsScaleInfo = z.infer<typeof STATS_SCALE_INFO_SCHEMA>;

/** Запрос stats/period (§11): {profileId, period}. */
export type StatsRequest = z.infer<typeof STATS_REQUEST_SCHEMA>;

/** Ответ stats/period (§11): {stats, scale}. */
export type StatsResponse = z.infer<typeof STATS_RESPONSE_SCHEMA>;
