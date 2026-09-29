/**
 * TASK-068 §5/§8: боевой адаптер порта ReportStatsSource (application reporting)
 * над публичным API analytics: точки периода (MeasurementPointsPort 052) → read
 * model buildPeriodStatistics (052 — ЕДИНЫЙ контракт потребителей, §3: «отчёт 068»)
 * → проекция в снапшот payload'а отчёта. НИКАКОЙ своей математики (арх. 02 §3.2):
 * средние/части/регулярность считает read model, адаптер только переименовывает
 * поля (средние — ValueStats.avg → sysAvg/diaAvg/pulseAvg).
 *
 * Инварианты flat-маппинга (§7): pulseAvg отсутствует, если измеренного пульса
 * не было (052 §13); утро/вечер отсутствуют, если в части нет записей (052 §13).
 * avg обязательный в снапшоте: use case вызывает getStatistics только после
 * count>0 (§9 — прецедент partAverages 052: часть существует ⇒ avg определён);
 * пустой период не доходит сюда (EMPTY_PERIOD отсечён раньше).
 */
import {
  buildPeriodStatistics,
  type MeasurementPoint,
  type MeasurementPointsPort,
  type MeasurementPointsQuery,
} from '../../analytics/index.js';

import type { ReportQuery, ReportStatsSource } from '../application/build-pdf-report.js';

/** Средние одной части снапшота: avg read model → число (инвариант выше, §7). */
function partAverages(part: {
  readonly count: number;
  readonly sys: { readonly avg?: number };
  readonly dia: { readonly avg?: number };
  readonly pulse?: { readonly avg?: number };
}): {
  count: number;
  sysAvg: number;
  diaAvg: number;
  pulseAvg?: number;
} {
  return {
    count: part.count,
    sysAvg: part.sys.avg as number,
    diaAvg: part.dia.avg as number,
    // avg определён у существующей части (инвариант 052: часть = ≥1 измерение);
    // явная проверка undefined вместо as — flat-маппинг §7 без лишнего ключа.
    ...(part.pulse !== undefined && part.pulse.avg !== undefined
      ? { pulseAvg: part.pulse.avg }
      : {}),
  };
}

/**
 * Адаптер статистики периода (§5 «stats (054)»): тот же порт точек, что у канала
 * stats/period (боевой MeasurementPointsAdapter контейнера); классификация шкалой
 * отчёту не нужна (шаблон 067 печатает только числа) — buildPeriodStatistics
 * вызывается без шкалы.
 */
export class ReportStatsAdapter implements ReportStatsSource {
  private readonly points: MeasurementPointsPort;

  constructor(points: MeasurementPointsPort) {
    this.points = points;
  }

  async getStatistics(
    query: ReportQuery,
  ): Promise<Awaited<ReturnType<ReportStatsSource['getStatistics']>>> {
    // Скоуп — как есть (§14): включительные границы порта TASK-021 §13.
    const scope: MeasurementPointsQuery = {
      profileId: query.profileId,
      fromUtcMs: query.fromUtcMs,
      toUtcMs: query.toUtcMs,
    };
    const points: MeasurementPoint[] = await this.points.listByPeriod(scope);
    const stats = buildPeriodStatistics(points);

    return {
      count: stats.count,
      sysAvg: stats.sys.avg as number,
      diaAvg: stats.dia.avg as number,
      ...(stats.pulse !== undefined ? { pulseAvg: stats.pulse.avg as number } : {}),
      ...(stats.morning !== undefined ? { morning: partAverages(stats.morning) } : {}),
      ...(stats.evening !== undefined ? { evening: partAverages(stats.evening) } : {}),
      daysWithMeasurements: stats.daysWithMeasurements,
      longestStreakDays: stats.longestStreakDays,
    };
  }
}
