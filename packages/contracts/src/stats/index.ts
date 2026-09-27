/** Публичный API контрактов stats/period (TASK-054 §5/§6): схемы и выводимые типы. */
export {
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
export type {
  PeriodStatisticsDto,
  StatsClassification,
  StatsClassificationNote,
  StatsPartStats,
  StatsPeriodParam,
  StatsRequest,
  StatsResponse,
  StatsScaleInfo,
  StatsValueStats,
} from './types.js';
