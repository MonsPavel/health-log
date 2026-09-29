// TASK-068 §5/§8/§19: юниты боевого адаптера ReportPointsAdapter — порт
// ReportPointsSource (application reporting) над репозиторием журнала measurement
// (BpMeasurementRepository, публичный API measurement — НОВОГО SQL НЕТ). Матрица:
//  - маппинг агрегата → ReportRow (bp развёрнут, takenAt — со СВОИМ offset EC-06);
//  - опциональные поля (пульс/рука/примечание) отсутствуют в строке, если их нет
//    во входе (flat-маппинг §7 — ключа нет, не null);
//  - скоуп: countByPeriod/listByPeriod передают {profileId, fromUtcMs, toUtcMs}
//    как есть (включительные границы порта TASK-021 §13).
//
// Агрегат в фикстуре — структурная форма порта (type-only импорт через публичный
// API measurement, прецедент json-snapshot-source.test.ts 065); живой путь
// (SQLite → агрегат → адаптер) покрывает smoke-тест build-pdf-report.int.test.ts.
import { describe, expect, it, vi } from 'vitest';

import { Instant } from '@hl/kernel';

import type { BpMeasurement } from '../../measurement/index.js';
import type { BpMeasurementRepository } from '../../measurement/index.js';
import { ReportPointsAdapter, toReportRow } from './report-points-adapter.js';

const PROFILE = 'seed-profile-0001';
const FROM = 1_758_000_000_000;
const TO = 1_758_816_000_000;

/** Агрегат журнала (структурная форма порта) — все поля заданы. */
const fullMeasurement = (): BpMeasurement =>
  ({
    id: 'm-1',
    profileId: PROFILE,
    bp: { sys: 118, dia: 76 },
    pulse: 64,
    irregularPulse: false,
    arm: 'right',
    note: 'после прогулки',
    takenAt: Instant.fromIso('2026-09-20T07:45:00.000+03:00'),
    source: 'manual',
    createdAtUtc: 0,
    updatedAtUtc: 0,
  }) as unknown as BpMeasurement;

/** Агрегат без опциональных полей: пульс не измерен, рука/примечание не заданы. */
const sparseMeasurement = (): BpMeasurement =>
  ({
    id: 'm-2',
    profileId: PROFILE,
    bp: { sys: 122, dia: 81 },
    pulse: undefined,
    irregularPulse: true,
    arm: undefined,
    note: undefined,
    takenAt: Instant.fromIso('2026-09-21T20:10:00.000+03:00'),
    source: 'manual',
    createdAtUtc: 0,
    updatedAtUtc: 0,
  }) as unknown as BpMeasurement;

const repoWith = (
  measurements: BpMeasurement[],
): {
  readonly repo: BpMeasurementRepository;
  readonly listByPeriod: ReturnType<typeof vi.fn>;
  readonly countByPeriod: ReturnType<typeof vi.fn>;
} => {
  const listByPeriod = vi.fn(() => Promise.resolve(measurements));
  const countByPeriod = vi.fn(() => Promise.resolve(measurements.length));
  return {
    repo: { listByPeriod, countByPeriod } as unknown as BpMeasurementRepository,
    listByPeriod,
    countByPeriod,
  };
};

describe('toReportRow — агрегат → строка отчёта (TASK-068 §5)', () => {
  it('bp развёрнут в sys/dia; utcMs/tzOffsetMin — из takenAt записи (EC-06)', () => {
    const row = toReportRow(fullMeasurement());
    expect(row).toEqual({
      utcMs: Instant.fromIso('2026-09-20T07:45:00.000+03:00').utcMs,
      tzOffsetMin: 180,
      sys: 118,
      dia: 76,
      pulse: 64,
      arm: 'right',
      note: 'после прогулки',
    });
  });

  it('опциональные поля отсутствуют, если их нет во входе (flat-маппинг §7)', () => {
    const row = toReportRow(sparseMeasurement());
    expect(Object.hasOwn(row, 'pulse')).toBe(false);
    expect(Object.hasOwn(row, 'arm')).toBe(false);
    expect(Object.hasOwn(row, 'note')).toBe(false);
    expect(row.sys).toBe(122);
    expect(row.dia).toBe(81);
  });
});

describe('ReportPointsAdapter — порт точек над репозиторием (§5/§8)', () => {
  it('listByPeriod: агрегаты → ReportRow[]; скоуп передаётся как есть (§14)', async () => {
    const { repo, listByPeriod } = repoWith([fullMeasurement(), sparseMeasurement()]);
    const adapter = new ReportPointsAdapter(repo);

    const rows = await adapter.listByPeriod({ profileId: PROFILE, fromUtcMs: FROM, toUtcMs: TO });

    expect(listByPeriod).toHaveBeenCalledWith({
      profileId: PROFILE,
      fromUtcMs: FROM,
      toUtcMs: TO,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sys: 118, dia: 76, pulse: 64 });
  });

  it('countByPeriod: быстрый count того же скоупа (§9 — валидация непустости)', async () => {
    const { repo, countByPeriod } = repoWith([]);
    const adapter = new ReportPointsAdapter(repo);

    await expect(
      adapter.countByPeriod({ profileId: PROFILE, fromUtcMs: FROM, toUtcMs: TO }),
    ).resolves.toBe(0);
    expect(countByPeriod).toHaveBeenCalledWith({
      profileId: PROFILE,
      fromUtcMs: FROM,
      toUtcMs: TO,
    });
  });
});
