// TASK-056 §19: юнит-тесты read model TrendSeries — чистая сборка над точками порта
// (fake вместо боевого адаптера, §19). Матрица:
//  - порог-пара (§20 AC1): 499 → raw, ровно 500 → raw (§13), 501 → daily (на генераторе);
//  - агрегация фикстуры (§20 AC2): 3 точки в дне — avg/min/max + morning/evening
//    раздельно; день с одной записью — avg=min=max (§13); день без утра/вечера —
//    поля отсутствуют; порядок дней wallDate asc ДАЖЕ при смешанных offset (EC-06);
//  - сортировка raw asc по utc + tie-break id (§9, §20 AC4); стабильность без id;
//  - пустой период → {mode:'raw', points:[]} (§11, §20 AC5);
//  - part (правило дня TASK-052) и critical (политика TASK-020) прокинуты в точки
//    (§20 AC3; сквозной с реальным адаптером — trends.int.test.ts);
//  - скоуп профиля и границы периода уходят в порт как есть (§14, §7);
//  - 10k генератор → daily ≤200 мс (§15/§19: сборка; рендер — TASK-062).
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { RAW_POINTS_LIMIT } from '@hl/contracts';
import { FixedClock, Instant } from '@hl/kernel';

import { generateDailyPeriod, point, type DailySlot } from './__fixtures__/periods.js';
import type {
  MeasurementPoint,
  MeasurementPointsPort,
  MeasurementPointsQuery,
} from './ports/measurement-points.js';
import { buildDayPoints, TrendSeries } from './trend-series.js';

/** Пояс фикстур +03:00 (FIXTURE_TZ_ISO) в минутах. */
const TZ = 180;

/** «Сейчас» FixedClock — после всех фикстурных дат. */
const NOW_MS = Instant.fromIso('2026-06-01T12:00:00.000+03:00').utcMs;

/** Один утренний слот — генератор длинных периодов для пороговой пары. */
const SINGLE_MORNING_SLOT: readonly DailySlot[] = [
  { wallTime: '07:00', sys: 120, dia: 80, pulse: 60, critical: undefined },
];

/** Десять слотов дня — генератор 10k (6 утра 06–11, 4 вечера 18–21). */
const TEN_SLOTS: readonly DailySlot[] = Array.from({ length: 10 }, (_, i) => ({
  wallTime: `${i < 6 ? i + 6 : i + 12}`.padStart(2, '0') + ':00',
  sys: 118 + i * 2,
  dia: 78 + i,
  pulse: 58 + i,
  critical: undefined,
}));

/** Fake порта точек: отдаёт массив КАК ЕСТЬ (порядок контролирует тест — порт порядок не гарантирует). */
class FakePointsPort implements MeasurementPointsPort {
  readonly queries: MeasurementPointsQuery[] = [];

  constructor(private readonly points: readonly MeasurementPoint[]) {}

  listByPeriod(query: MeasurementPointsQuery): Promise<MeasurementPoint[]> {
    this.queries.push(query);
    return Promise.resolve([...this.points]);
  }
}

/** Серия с fake-портом и фиксированным часами. */
const makeSeries = (points: readonly MeasurementPoint[]): TrendSeries =>
  new TrendSeries({ points: new FakePointsPort(points), clock: new FixedClock(NOW_MS, TZ) });

describe('TrendSeries.getTrendSeries — порог raw/daily (§13: ровно 500 → raw, 501 → daily)', () => {
  it('(AC1) 499 точек на генераторе → raw, points.length = 499', async () => {
    const series = makeSeries(generateDailyPeriod('2025-01-01', 499, SINGLE_MORNING_SLOT));
    const response = await series.getTrendSeries('profile-1', 'all');
    expect(response.mode).toBe('raw');
    expect(response.points?.length).toBe(499);
    expect('days' in response).toBe(false);
  });

  it('ровно RAW_POINTS_LIMIT (500) точек → raw — граница включительно (§13)', async () => {
    expect(RAW_POINTS_LIMIT).toBe(500);
    const series = makeSeries(generateDailyPeriod('2025-01-01', 500, SINGLE_MORNING_SLOT));
    const response = await series.getTrendSeries('profile-1', 'all');
    expect(response.mode).toBe('raw');
    expect(response.points?.length).toBe(500);
  });

  it('(AC1) 501 точка → daily, дней 501; день из одной записи — avg=min=max, morning есть, evening нет (§13)', async () => {
    const series = makeSeries(generateDailyPeriod('2025-01-01', 501, SINGLE_MORNING_SLOT));
    const response = await series.getTrendSeries('profile-1', 'all');
    expect(response.mode).toBe('daily');
    expect('points' in response).toBe(false);
    expect(response.days?.length).toBe(501);
    const first = response.days?.[0];
    expect(first).toEqual({
      wallDate: '2025-01-01',
      sysAvg: 120,
      sysMin: 120,
      sysMax: 120,
      diaAvg: 80,
      diaMin: 80,
      diaMax: 80,
      morningSysAvg: 120,
      count: 1,
    });
  });

  it('порог считается по точкам ПЕРИОДА: порты получает границы пресета от Clock (§7)', async () => {
    const port = new FakePointsPort([]);
    const series = new TrendSeries({ points: port, clock: new FixedClock(NOW_MS, TZ) });
    await series.getTrendSeries('profile-1', '7d');
    expect(port.queries[0]).toEqual({
      profileId: 'profile-1',
      fromUtcMs: NOW_MS - 7 * 86_400_000,
    });
  });

  it('custom-период проходит в порт как есть (обе границы включительно — TASK-046)', async () => {
    const port = new FakePointsPort([]);
    const series = new TrendSeries({ points: port, clock: new FixedClock(NOW_MS, TZ) });
    const period = { fromUtcMs: 1000, toUtcMs: 2000 };
    await series.getTrendSeries('profile-1', period);
    expect(port.queries[0]).toEqual({ profileId: 'profile-1', fromUtcMs: 1000, toUtcMs: 2000 });
  });
});

describe('buildDayPoints — агрегация настенного дня (§4/§13, семантика дней TASK-046)', () => {
  it('(AC2) 3 точки в дне: avg (округлён до 1 знака) / min / max + morning/evening раздельно', () => {
    // 07:00 120/80, 08:00 122/82, 20:00 130/85: sys 124 [120..130],
    // dia 247/3 = 82.333… → 82.3; morningSysAvg 121, eveningSysAvg 130.
    const days = buildDayPoints([
      point('2026-03-02', '07:00', 120, 80, 60),
      point('2026-03-02', '08:00', 122, 82, 64),
      point('2026-03-02', '20:00', 130, 85, 70),
    ]);
    expect(days).toEqual([
      {
        wallDate: '2026-03-02',
        sysAvg: 124,
        sysMin: 120,
        sysMax: 130,
        diaAvg: 82.3,
        diaMin: 80,
        diaMax: 85,
        morningSysAvg: 121,
        eveningSysAvg: 130,
        count: 3,
      },
    ]);
  });

  it('день с одной записью — avg=min=max (§13); день без утра/вечера — поля отсутствуют (не null)', () => {
    const days = buildDayPoints([
      point('2026-03-03', '07:30', 125, 82),
      point('2026-03-04', '12:30', 128, 84),
    ]);
    expect(days).toEqual([
      {
        wallDate: '2026-03-03',
        sysAvg: 125,
        sysMin: 125,
        sysMax: 125,
        diaAvg: 82,
        diaMin: 82,
        diaMax: 82,
        morningSysAvg: 125,
        count: 1,
      },
      {
        wallDate: '2026-03-04',
        sysAvg: 128,
        sysMin: 128,
        sysMax: 128,
        diaAvg: 84,
        diaMin: 84,
        diaMax: 84,
        count: 1,
      },
    ]);
    expect('morningSysAvg' in days[1]).toBe(false);
    expect('eveningSysAvg' in days[1]).toBe(false);
  });

  it('дни сортированы wallDate asc даже когда utc-порядок входа даёт другой настенный порядок (EC-06: свой offset записи)', () => {
    // A: настенное 2026-03-11T02:00 (+14:00) → utc 2026-03-10T12:00Z, день 2026-03-11;
    // B: настенное 2026-03-10T23:00 (−12:00) → utc 2026-03-11T11:00Z, день 2026-03-10.
    // Вход по utc asc [A, B] даёт дни [03-11, 03-10] — выход обязан пересортировать.
    const a: MeasurementPoint = {
      sys: 120,
      dia: 80,
      pulse: undefined,
      takenAt: Instant.fromIso('2026-03-11T02:00:00.000+14:00'),
      critical: undefined,
    };
    const b: MeasurementPoint = {
      sys: 130,
      dia: 85,
      pulse: undefined,
      takenAt: Instant.fromIso('2026-03-10T23:00:00.000-12:00'),
      critical: undefined,
    };
    const days = buildDayPoints([a, b]);
    expect(days.map((day) => day.wallDate)).toEqual(['2026-03-10', '2026-03-11']);
    expect(days[0]?.count).toBe(1);
    expect(days[1]?.count).toBe(1);
  });
});

describe('TrendSeries.getTrendSeries — сырые точки: сортировка и прокидывание флагов', () => {
  it('(AC4) сортировка utc asc независимо от порядка порта (график слева-направо, §9)', async () => {
    // Вход — в обратном порядке; значения sys различны — порядок выхода виден по ним.
    const series = makeSeries([
      point('2026-03-03', '08:00', 122, 82),
      point('2026-03-01', '08:00', 120, 80),
      point('2026-03-02', '08:00', 121, 81),
    ]);
    const response = await series.getTrendSeries('profile-1', 'all');
    expect(response.points?.map((p) => p.sys)).toEqual([120, 121, 122]);
  });

  it('(AC4) tie-break по id asc при равных utc (§9); без id — стабильность входа', async () => {
    const sameUtc = point('2026-03-02', '08:00', 121, 81).takenAt.utcMs;
    const late: MeasurementPoint = {
      id: 'id-z',
      sys: 122,
      dia: 82,
      pulse: undefined,
      takenAt: { utcMs: sameUtc, tzOffsetMin: TZ },
      critical: undefined,
    };
    const early: MeasurementPoint = {
      id: 'id-a',
      sys: 121,
      dia: 81,
      pulse: undefined,
      takenAt: { utcMs: sameUtc, tzOffsetMin: TZ },
      critical: undefined,
    };
    const withIds = await makeSeries([late, early]).getTrendSeries('profile-1', 'all');
    expect(withIds.mode).toBe('raw');
    expect(withIds.points?.map((p) => p.sys)).toEqual([121, 122]);

    const noIdFirst: MeasurementPoint = { ...late, id: undefined };
    const noIdSecond: MeasurementPoint = { ...early, id: undefined };
    const stable = await makeSeries([noIdFirst, noIdSecond]).getTrendSeries('profile-1', 'all');
    expect(stable.points?.map((p) => p.sys)).toEqual([122, 121]);
  });

  it('(AC3) part — правило дня TASK-052: 07:00 → morning, 12:30 → other, 20:00 → evening', async () => {
    const series = makeSeries([
      point('2026-03-02', '07:00', 120, 80),
      point('2026-03-02', '12:30', 122, 82),
      point('2026-03-02', '20:00', 124, 84),
    ]);
    const response = await series.getTrendSeries('profile-1', 'all');
    expect(response.points?.map((p) => p.part)).toEqual(['morning', 'other', 'evening']);
  });

  it('(AC3) critical прокинут (190/125 → high), отсутствие флага/пульса — поле отсутствует в JSON (§7)', async () => {
    const series = makeSeries([
      point('2026-04-02', '07:30', 190, 125, 90, 'high'),
      point('2026-04-03', '07:30', 120, 80),
    ]);
    const response = await series.getTrendSeries('profile-1', 'all');
    const [critical, plain] = response.points ?? [];
    expect(critical).toEqual({
      utcMs: critical?.utcMs,
      tzOffsetMin: TZ,
      sys: 190,
      dia: 125,
      pulse: 90,
      part: 'morning',
      critical: 'high',
    });
    expect('critical' in plain).toBe(false);
    expect('pulse' in plain).toBe(false);
  });

  it('точка несёт свой offset записи (EC-06), а не пояс профиля', async () => {
    const series = makeSeries([
      {
        sys: 120,
        dia: 80,
        pulse: undefined,
        takenAt: Instant.fromIso('2026-03-10T14:00:00.000+14:00'),
        critical: undefined,
      },
    ]);
    const response = await series.getTrendSeries('profile-1', 'all');
    expect(response.points?.[0]?.tzOffsetMin).toBe(14 * 60);
  });

  // TASK-057 §12 (ДОПОЛНЕНИЕ КОНТРАКТА): id записи прокидывается в сырую точку —
  // переход к правке из тултипа графика; точки без id (ручные фикстуры) — поле
  // отсутствует в JSON (§7).
  it('(057 §12) id записи прокинут в сырую точку; без id — поле отсутствует', async () => {
    const response = await makeSeries([
      { ...point('2026-03-02', '07:00', 120, 80), id: 'rec-1' },
      point('2026-03-02', '20:00', 130, 85),
    ]).getTrendSeries('profile-1', 'all');
    const [withId, withoutId] = response.points ?? [];
    expect(withId?.id).toBe('rec-1');
    expect('id' in withoutId).toBe(false);
  });
});

describe('TrendSeries.getTrendSeries — пустой период и скоуп (§11/§14)', () => {
  it('(AC5) пустой период → {mode:"raw", points:[]}, days отсутствует (§11)', async () => {
    const response = await makeSeries([]).getTrendSeries('profile-1', 'all');
    expect(response).toEqual({ mode: 'raw', points: [] });
  });

  it('profileId уходит в порт — принудительный скоуп (§14); "all" — без границ', async () => {
    const port = new FakePointsPort([]);
    const series = new TrendSeries({ points: port, clock: new FixedClock(NOW_MS, TZ) });
    await series.getTrendSeries('profile-42', 'all');
    expect(port.queries[0]).toEqual({ profileId: 'profile-42' });
  });
});

describe('TrendSeries — 10k точек (§15/§19: сборка ≤200 мс; рендер — TASK-062)', () => {
  it('10k генератор → daily ≤200 мс, 1000 дней × 10 записей', async () => {
    const tenK = generateDailyPeriod('2025-01-01', 1000, TEN_SLOTS);
    expect(tenK.length).toBe(10_000);
    const series = makeSeries(tenK);

    const startedAtMs = performance.now();
    const response = await series.getTrendSeries('profile-1', 'all');
    const durationMs = performance.now() - startedAtMs;

    expect(response.mode).toBe('daily');
    expect(response.days?.length).toBe(1000);
    expect(response.days?.[0]?.count).toBe(10);
    expect(
      durationMs,
      `сборка trend/series на 10k точек: ${Math.round(durationMs)} мс — бюджет §15 (200 мс)`,
    ).toBeLessThanOrEqual(200);
  }, 30_000);
});
