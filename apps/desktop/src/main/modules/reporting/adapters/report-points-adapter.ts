/**
 * TASK-068 §5/§8: боевой адаптер порта ReportPointsSource (application reporting)
 * над репозиторием журнала measurement (BpMeasurementRepository — НОВОГО SQL НЕТ,
 * индекс v1 покрывает период; публичный API measurement — единственный межмодульный
 * вход, арх. 03 §4). Трансляция агрегата BpMeasurement → строка отчёта (ReportRow
 * 067): bp развёрнут в sys/dia, «пульс не измерен»/рука/примечание отсутствуют →
 * ключа нет (flat-маппинг §7), takenAt — как хранится, со СВОИМ offset (EC-06:
 * колонки Дата/Время таблицы считаются по offset точки).
 *
 * «ReportRow-маппинг агрегата» живёт здесь: только adapters вправе импортировать
 * чужой модуль (прецедент MeasurementExportAdapter TASK-065). Сортировку адаптер
 * НЕ гарантирует (контракт listByPeriod — takenAt desc): use case строит payload
 * asc сам (build-pdf-report §5). Асинхронность — единообразно с портом.
 */
import type { BpMeasurement, BpMeasurementRepository } from '../../measurement/index.js';

import type { ReportPointsSource } from '../application/build-pdf-report.js';
import type { ReportRow } from '../application/report-spec.js';

/** Строка отчёта из агрегата журнала (§5): плоские числа + момент со своим offset. */
export function toReportRow(m: BpMeasurement): ReportRow {
  return {
    utcMs: m.takenAt.utcMs,
    tzOffsetMin: m.takenAt.tzOffsetMin,
    sys: m.bp.sys,
    dia: m.bp.dia,
    ...(m.pulse !== undefined ? { pulse: m.pulse } : {}),
    ...(m.arm !== undefined ? { arm: m.arm } : {}),
    ...(m.note !== undefined ? { note: m.note } : {}),
  };
}

/** Скоуп выборки (§14): порт принимает ровно поля, нужные отчёту. */
export interface ReportScope {
  readonly profileId: string;
  readonly fromUtcMs: number;
  readonly toUtcMs: number;
}

/**
 * Адаптер чтения сырых точек и count периода (§5/§9): профиль-скоуп и включительные
 * границы проходят в репозиторий как есть (семантики TASK-021 §13 — [from, to]).
 */
export class ReportPointsAdapter implements ReportPointsSource {
  private readonly repo: BpMeasurementRepository;

  constructor(repo: BpMeasurementRepository) {
    this.repo = repo;
  }

  countByPeriod(query: ReportScope): Promise<number> {
    return this.repo.countByPeriod(query);
  }

  listByPeriod(query: ReportScope): Promise<ReportRow[]> {
    return this.repo.listByPeriod(query).then((measurements) => measurements.map(toReportRow));
  }
}
