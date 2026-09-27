/**
 * TASK-052 §5: порт чтения сырых точек периода — application-слой модуля analytics
 * (арх. 03 §4: application не импортирует чужие модули — depcruise application-ports;
 * прецедент TASK-051: собственный порт + wire-up контейнером). Зеркало контракта
 * `BpMeasurementRepository.listByPeriod` (TASK-021 §4/§7): НОВОГО SQL НЕТ (§5) —
 * боевая реализация (TASK-054, канал analytics/period-statistics) — тонкий адаптер
 * над репозиторием measurement, транслирующий агрегат BpMeasurement в сырую точку.
 *
 * §4 (гибрид): SELECT достаёт сырые точки — минимум SQL-логики, вся математика —
 * чистый TS домена (§5). Флаг critical ставит адаптер ПОЛИТИКОЙ TASK-020
 * (assessCritical(sys, dia): sys ≥ 180 ∨ dia ≥ 120 → 'high'; sys ≤ 90 ∨ dia ≤ 60 →
 * 'low'; границы включительно) — пороги живут в measurement/domain/constants, здесь
 * не дублируются: критерии клинические, расхождение копий недопустимо (NFR-10).
 *
 * Асинхронность — единообразно с портами ScaleRepository/BpMeasurementRepository.
 */
import type { Instant } from '@hl/kernel';

/**
 * Сырая точка измерения для аналитики (§4): плоские числа + Instant. Спроекция
 * агрегата BpMeasurement (TASK-017): bp.sys/bp.dia развёрнуты, pulse — «не измерен»
 * → undefined (FR-1.1), takenAt — как хранится (со своим offset — EC-06).
 */
export interface MeasurementPoint {
  /** Систолическое АД, мм рт. ст. (валидность гарантирует источник — TASK-016). */
  readonly sys: number;
  /** Диастолическое АД, мм рт. ст. */
  readonly dia: number;
  /** ЧСС, уд/мин; undefined — не измерен (FR-1.1). */
  readonly pulse: number | undefined;
  /** Момент измерения (UTC + собственный offset записи — EC-06). */
  readonly takenAt: Instant;
  /** Флаг критичности пары (sys, dia) по политике TASK-020 (ставит адаптер порта). */
  readonly critical: 'high' | 'low' | undefined;
}

/**
 * Запрос выборки точек — подмножество MeasurementQuery (TASK-021 §7), нужное
 * статистике периода: профиль-скоуп (обязателен, §14) и границы периода по
 * takenAt.utcMs, обе включительно (§13 TASK-021). arm/hasNote/limit/offset
 * статистике не нужны (§5: период целиком).
 */
export interface MeasurementPointsQuery {
  /** Профиль-владелец: обязателен — принудительный скоуп (арх. 08 §3). */
  readonly profileId: string;
  /** Нижняя граница периода по takenAt.utcMs, включительно. */
  readonly fromUtcMs?: number;
  /** Верхняя граница периода по takenAt.utcMs, включительно. */
  readonly toUtcMs?: number;
}

/** Порт чтения сырых точек периода (§5; реализация — адаптер TASK-054, без нового SQL). */
export interface MeasurementPointsPort {
  /** Точки периода; сортировка не гарантирована — агрегаты порядок-инвариантны (§19). */
  listByPeriod(query: MeasurementPointsQuery): Promise<MeasurementPoint[]>;
}
