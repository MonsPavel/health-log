// TASK-068 §5/§8/§19: юниты боевого адаптера ReportStatsAdapter — порт
// ReportStatsSource (application reporting) над публичным API analytics:
// точки периода (MeasurementPointsPort 052) → read model buildPeriodStatistics
// (052, §5 «stats (054)») → снапшот в форме payload'а отчёта. Никакой своей
// математики (арх. 02 §3.2) — только проекция read model. Матрица:
//  - полная проекция: period {count, sysAvg, diaAvg, pulseAvg}, morning, streak;
//  - pulseAvg отсутствует, если ни одного измеренного пульса (052 §13);
//  - части без измерений (утро/вечер) отсутствуют в снапшоте (052 §13);
//  - insufficientData не мешает значениям (052 EC-09: классификация — не тут);
//  - скоуп {profileId, fromUtcMs, toUtcMs} передаётся порту как есть (§14).
import { describe, expect, it, vi } from 'vitest';

import { Instant } from '@hl/kernel';

import type { MeasurementPoint } from '../../analytics/index.js';
import type { MeasurementPointsPort } from '../../analytics/index.js';
import { ReportStatsAdapter } from './report-stats-adapter.js';

const PROFILE = 'seed-profile-0001';
const QUERY = { profileId: PROFILE, fromUtcMs: 1_758_000_000_000, toUtcMs: 1_758_816_000_000 };

/** Точка аналитики (форма MeasurementPoint 052). */
const point = (overrides: Partial<MeasurementPoint>): MeasurementPoint => ({
  sys: 118,
  dia: 76,
  pulse: undefined,
  takenAt: Instant.fromIso('2026-09-20T07:45:00.000+03:00'),
  critical: undefined,
  ...overrides,
});

const portWith = (
  points: MeasurementPoint[],
): {
  readonly port: MeasurementPointsPort;
  readonly listByPeriod: ReturnType<typeof vi.fn>;
} => {
  const listByPeriod = vi.fn(() => Promise.resolve(points));
  return { port: { listByPeriod }, listByPeriod };
};

describe('ReportStatsAdapter — проекция read model 052 в снапшот отчёта (§5)', () => {
  it('period {count, sysAvg, diaAvg, pulseAvg} + morning + regularity; скоуп как есть', async () => {
    const { port, listByPeriod } = portWith([
      point({ pulse: 64, takenAt: Instant.fromIso('2026-09-20T07:45:00.000+03:00') }),
      point({
        sys: 126,
        dia: 84,
        pulse: 70,
        takenAt: Instant.fromIso('2026-09-21T20:30:00.000+03:00'),
      }),
    ]);
    const adapter = new ReportStatsAdapter(port);

    const snapshot = await adapter.getStatistics(QUERY);

    expect(listByPeriod).toHaveBeenCalledWith(QUERY);
    expect(snapshot.count).toBe(2);
    expect(snapshot.sysAvg).toBeCloseTo((118 + 126) / 2, 5);
    expect(snapshot.diaAvg).toBeCloseTo((76 + 84) / 2, 5);
    expect(snapshot.pulseAvg).toBeCloseTo((64 + 70) / 2, 5);
    // Утро есть (одна точка 07:45 wall), вечера нет (20:30 — вечер? см. 052: часть
    // по правилу дня; 20:30 принадлежит вечеру) — снапшот отражает фактический сплит.
    expect(snapshot.morning).toBeDefined();
    expect(snapshot.evening).toBeDefined();
    expect(snapshot.daysWithMeasurements).toBe(2);
    expect(snapshot.longestStreakDays).toBe(2);
  });

  it('нет измеренного пульса → pulseAvg отсутствует (052 §13), чисел нуля нет', async () => {
    const { port } = portWith([
      point({}),
      point({ sys: 120, dia: 80, takenAt: Instant.fromIso('2026-09-21T08:00:00.000+03:00') }),
    ]);
    const adapter = new ReportStatsAdapter(port);

    const snapshot = await adapter.getStatistics(QUERY);

    expect(Object.hasOwn(snapshot, 'pulseAvg')).toBe(false);
  });

  it('часть суток без измерений → соответствующее поле отсутствует (052 §13)', async () => {
    // Единственная точка утром 2026-09-20 → вечерней части нет.
    const { port } = portWith([point({ pulse: 60 })]);
    const adapter = new ReportStatsAdapter(port);

    const snapshot = await adapter.getStatistics(QUERY);

    expect(snapshot.morning).toBeDefined();
    expect(Object.hasOwn(snapshot, 'evening')).toBe(false);
  });
});
