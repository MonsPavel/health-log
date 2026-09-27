/**
 * Публичный API модуля measurement (арх. 03 §4: чужой модуль импортируется ТОЛЬКО
 * через этот index — правило module-public-api TASK-005). Минимальная поверхность
 * для межмодульных потребителей: порт журнала измерений и политика критических
 * значений. Первый межмодульный потребитель — аналитика TASK-054 (адаптер точек
 * периода над репозиторием журнала); расширять список экспорта осознанно.
 */
export type { Arm } from './domain/arm.js';
export type { BpMeasurement, MeasurementSource } from './domain/bp-measurement.js';
export type { BpMeasurementRepository, MeasurementQuery } from './application/ports/bp-measurement-repository.js';
export { assessCritical, type CriticalFlag } from './domain/critical-value-policy.js';
