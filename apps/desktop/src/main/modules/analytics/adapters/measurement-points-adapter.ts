/**
 * TASK-054 §5: боевой адаптер порта MeasurementPointsPort (TASK-052 §5) над
 * репозиторием журнала измерений measurement (BpMeasurementRepository.listByPeriod —
 * НОВОГО SQL НЕТ, индекс v1 покрывает период). Трансляция агрегата BpMeasurement
 * (TASK-017) в сырую точку аналитики: bp развёрнут в sys/dia, «пульс не измерен» →
 * undefined, takenAt — как хранится (со СВОИМ offset — EC-06). Флаг critical
 * проставлен ПОЛИТИКОЙ TASK-020 (assessCritical: sys ≥ 180 ∨ dia ≥ 120 → 'high';
 * sys ≤ 90 ∨ dia ≤ 60 → 'low'; границы включительно) — пороги живут в
 * measurement/domain/constants, здесь не дублируются (NFR-10, прецедент
 * золотых фикстур TASK-052 §5: «так боевую точку готовит адаптер порта»).
 *
 * Межмодульный импорт — только публичный API measurement/index.ts (арх. 03 §4,
 * правило module-public-api TASK-005). Асинхронность — единообразно с портом.
 */
import {
  assessCritical,
  type BpMeasurement,
  type BpMeasurementRepository,
} from '../../measurement/index.js';

import type {
  MeasurementPoint,
  MeasurementPointsPort,
  MeasurementPointsQuery,
} from '../application/ports/measurement-points.js';

/** Точка аналитики из агрегата журнала (§4): id + плоские числа + Instant + флаг политики. */
function aggregateToPoint(m: BpMeasurement): MeasurementPoint {
  return {
    id: m.id,
    sys: m.bp.sys,
    dia: m.bp.dia,
    pulse: m.pulse,
    takenAt: m.takenAt,
    critical: assessCritical(m.bp.sys, m.bp.dia),
    // TASK-058 §9 (EC-10): флаг записи «неровный пульс» — как есть, без
    // переосмысления; false/отсутствие → поле не ставится (§7 flat-маппинг).
    ...(m.irregularPulse ? { irregular: true } : {}),
    // TASK-059 §5: рука измерения — как в агрегате (колонка «Рука» таблицы
    // TASK-059 строится из того же провода); отсутствует → поле не ставится (§7).
    ...(m.arm !== undefined ? { arm: m.arm } : {}),
  };
}

/**
 * Адаптер чтения сырых точек периода (§5): профиль-скоуп и включительные границы
 * query проходят в репозиторий как есть (семантики TASK-021 §13 — [from, to] включительно).
 */
export class MeasurementPointsAdapter implements MeasurementPointsPort {
  private readonly repo: BpMeasurementRepository;

  constructor(repo: BpMeasurementRepository) {
    this.repo = repo;
  }

  listByPeriod(query: MeasurementPointsQuery): Promise<MeasurementPoint[]> {
    return this.repo.listByPeriod(query).then((measurements) => measurements.map(aggregateToPoint));
  }
}
