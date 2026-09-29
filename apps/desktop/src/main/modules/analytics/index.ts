/**
 * analytics — публичный API модуля (арх. 03 §4: чужой модуль импортируется ТОЛЬКО
 * через этот index — правило module-public-api TASK-005; прецедент measurement/index.ts).
 *
 * Минимальная поверхность для межмодульных потребителей: порт сырых точек периода
 * (TASK-052) и сборщик read model статистики (052). Первый межмодульный потребитель —
 * TASK-054 (канал stats/period внутри модуля); TASK-068 — адаптер статистики
 * PDF-отчёта в reporting/adapters (переиспользование read model, без новой математики).
 * Расширять список экспорта осознанно.
 */
export type {
  MeasurementPoint,
  MeasurementPointsPort,
  MeasurementPointsQuery,
} from './application/ports/measurement-points.js';
export { buildPeriodStatistics, type PeriodStatistics } from './application/period-statistics.js';
