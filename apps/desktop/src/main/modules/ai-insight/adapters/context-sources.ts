/**
 * TASK-083 §5/§8: боевые адаптеры портов AiContextBuilder над публичным API
 * смежных модулей (арх. 03 §4: межмодульно — только index.ts; НОВОГО SQL НЕТ —
 * §8: чтение через существующие read models/репозиторий):
 *  - ContextPointsAdapter — точки периода С ЗАМЕТКАМИ (§5): адаптер над журналом
 *    measurement — паттерн MeasurementPointsAdapter (TASK-054), плюс note записи;
 *    critical проставляет политика TASK-020 (пороги не дублируются, NFR-10);
 *  - ContextStatsAdapter — агрегаты периода: точки (порт 052) → read model
 *    buildPeriodStatistics (052/054 — ЕДИНЫЙ контракт потребителей, §3) со шкалой
 *    → проводная форма PeriodStatisticsDto (toDto 054: JSON round-trip);
 *  - ContextSeriesAdapter — серии периода: buildTrendResponse (056) с ЯВНЫМ
 *    режимом — лимит контекст-окна (CONTEXT_MAX_DAYS) решает сборщик, §5.
 *
 * Асинхронность — единообразно с портами (052). PHI: точки содержат заметки —
 * порт внутренний (application ai-insight), на renderer идут только собранные
 * текст/секции по схеме канала (§14).
 */
import type { ActiveScale, PeriodStatisticsDto, TrendResponse } from '@hl/contracts';

import {
  assessCritical,
  type BpMeasurement,
  type BpMeasurementRepository,
} from '../../measurement/index.js';
import {
  buildPeriodStatistics,
  buildTrendResponse,
  type MeasurementPoint,
  type MeasurementPointsPort,
  type MeasurementPointsQuery,
} from '../../analytics/index.js';

import type {
  ContextPoint,
  ContextPointsPort,
  ContextPointsQuery,
  ContextSeriesMode,
  ContextSeriesPort,
  ContextStatsPort,
} from '../application/ports/ai-context.js';

/** Поверхность источника активной шкалы (§5 «шкала (051)»; ScaleService ей удовлетворяет). */
export interface ContextScaleSource {
  getActiveScale(): Promise<ActiveScale>;
}

/** Точка контекста из агрегата журнала (§5): плоские числа + Instant + флаги + заметка. */
function aggregateToContextPoint(m: BpMeasurement): ContextPoint {
  return {
    id: m.id,
    sys: m.bp.sys,
    dia: m.bp.dia,
    pulse: m.pulse,
    takenAt: m.takenAt,
    critical: assessCritical(m.bp.sys, m.bp.dia),
    ...(m.irregularPulse ? { irregular: true } : {}),
    ...(m.arm !== undefined ? { arm: m.arm } : {}),
    ...(m.note !== undefined ? { note: m.note } : {}),
  };
}

/** Адаптер точек периода с заметками (§5/§14): скоуп/границы — семантики TASK-021 §13. */
export class ContextPointsAdapter implements ContextPointsPort {
  private readonly repo: BpMeasurementRepository;

  constructor(repo: BpMeasurementRepository) {
    this.repo = repo;
  }

  listByPeriod(query: ContextPointsQuery): Promise<ContextPoint[]> {
    return this.repo
      .listByPeriod(query)
      .then((measurements) => measurements.map(aggregateToContextPoint));
  }
}

/** Адаптер агрегатов периода (§5 «stats (054 read model)»): та же сборка, что у канала stats/period. */
export class ContextStatsAdapter implements ContextStatsPort {
  private readonly points: MeasurementPointsPort;

  private readonly scales: ContextScaleSource;

  constructor(points: MeasurementPointsPort, scales: ContextScaleSource) {
    this.points = points;
    this.scales = scales;
  }

  async getStatistics(query: ContextPointsQuery): Promise<PeriodStatisticsDto> {
    const scale = await this.scales.getActiveScale();
    const scope: MeasurementPointsQuery = {
      profileId: query.profileId,
      fromUtcMs: query.fromUtcMs,
      toUtcMs: query.toUtcMs,
    };
    const selected: MeasurementPoint[] = await this.points.listByPeriod(scope);
    // toDto (§7 054): JSON round-trip — undefined-части исчезают, форма = провод канала.
    return JSON.parse(JSON.stringify(buildPeriodStatistics(selected, scale))) as PeriodStatisticsDto;
  }
}

/** Адаптер серий периода (§5 «серии (056)»): режим явный — решает сборщик (§5). */
export class ContextSeriesAdapter implements ContextSeriesPort {
  private readonly points: MeasurementPointsPort;

  constructor(points: MeasurementPointsPort) {
    this.points = points;
  }

  async getSeries(query: ContextPointsQuery, mode: ContextSeriesMode): Promise<TrendResponse> {
    const scope: MeasurementPointsQuery = {
      profileId: query.profileId,
      fromUtcMs: query.fromUtcMs,
      toUtcMs: query.toUtcMs,
    };
    const selected: MeasurementPoint[] = await this.points.listByPeriod(scope);
    return buildTrendResponse(selected, mode);
  }
}
