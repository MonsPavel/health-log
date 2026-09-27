// TASK-052 §19: сборщик PeriodStatistics — golden-фикстуры (5 ручных эталонов, AC §20
// п. 1: все поля §7, включая undefined-ветки), пустой период (AC §20 п. 2: count=0,
// части undefined, insufficientData оба true, БЕЗ NaN), пороги «мало данных» (kernel
// AI_MIN_MEASUREMENTS/AI_MIN_DAYS — общие с AI Insight, арх. 02 §3.2), SD n=1/n=2
// (AC §20), delta только при обеих частях (§13), property-тесты fast-check:
// перестановка записей не меняет агрегаты, добавление записи не уменьшает count/дни,
// NaN-свобода (§19). Сборщик — чистая функция над точками порта (§9).
// TASK-053 §5: интеграция классификатора — опциональный параметр шкалы (аддитивно:
// без шкалы поля classification нет), поле заполняется на фикстурах (b)/(d)/(a);
// insufficientData (пороги kernel) → средние подаются классификатору как undefined.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AI_MIN_DAYS, AI_MIN_MEASUREMENTS } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';

import { INSUFFICIENT_DATA_NOTE_TEXT } from '../domain/classifier.js';
import { GOLDEN_FIXTURES, point } from './__fixtures__/periods.js';
import { buildPeriodStatistics } from './period-statistics.js';
import type { MeasurementPoint } from './ports/measurement-points.js';
import type { GoldenFixture } from './__fixtures__/periods.js';

/** Golden-фикстура по префиксу имени (без non-null assertion; ошибка — явный throw). */
function fixture(namePrefix: string): GoldenFixture {
  const found = GOLDEN_FIXTURES.find((f) => f.name.startsWith(namePrefix));
  if (found === undefined) {
    throw new Error(`golden-фикстура ${namePrefix} не найдена`);
  }
  return found;
}

/** Пути до NaN в структуре (AC §20 п. 2: пустой период без NaN). */
function nanPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? [path] : [];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      nanPaths(v, `${path}.${k}`),
    );
  }
  return [];
}

/** Произвольная точка: валидные диапазоны значений, произвольный момент и пояс. */
const pointArb: fc.Arbitrary<MeasurementPoint> = fc.record({
  sys: fc.integer({ min: 50, max: 300 }),
  dia: fc.integer({ min: 20, max: 200 }),
  pulse: fc.option(fc.integer({ min: 20, max: 300 }), { nil: undefined }),
  takenAt: fc.record({
    utcMs: fc.integer({ min: 1_577_836_800_000, max: 1_831_232_000_000 }), // 2020..2028
    tzOffsetMin: fc.integer({ min: -840, max: 840 }),
  }),
  critical: fc.option(fc.constantFrom('high' as const, 'low' as const), { nil: undefined }),
});

/** Детерминированная перестановка (LCG): свойство порядок-инвариантности §19. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let s = seed % 2_147_483_647;
  if (s <= 0) {
    s += 2_147_483_646;
  }
  for (let i = copy.length - 1; i > 0; i -= 1) {
    s = (s * 48_271) % 2_147_483_647;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

describe('buildPeriodStatistics — golden-фикстуры §19 (AC §20 п. 1)', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`${fixture.name} — совпадение с ручным эталоном по всем полям §7`, () => {
      expect(buildPeriodStatistics(fixture.points())).toEqual(fixture.expected);
    });
  }
});

describe('buildPeriodStatistics — пустой период (AC §20 п. 2, §9)', () => {
  it('count=0, все части undefined, insufficientData оба true, без NaN', () => {
    const stats = buildPeriodStatistics([]);
    expect(stats).toEqual({
      count: 0,
      sys: { avg: undefined, min: undefined, max: undefined, sd: undefined },
      dia: { avg: undefined, min: undefined, max: undefined, sd: undefined },
      pulse: undefined,
      morning: undefined,
      evening: undefined,
      other: undefined,
      delta: undefined,
      critical: { high: false, low: false },
      daysWithMeasurements: 0,
      longestStreakDays: 0,
      insufficientData: { tooFewMeasurements: true, tooFewDays: true },
    });
    expect(nanPaths(stats)).toEqual([]);
    expect('lastMeasurementUtcMs' in stats).toBe(false);
  });
});

describe('buildPeriodStatistics — пороги «мало данных» (kernel, FR-5.4)', () => {
  it('ровно 7 измерений и 3 дня → оба false (границы включительно)', () => {
    const points = [
      point('2026-05-01', '07:00', 120, 80),
      point('2026-05-01', '20:00', 122, 81),
      point('2026-05-01', '21:00', 121, 80),
      point('2026-05-02', '07:00', 119, 79),
      point('2026-05-02', '20:00', 123, 82),
      point('2026-05-03', '07:00', 120, 80),
      point('2026-05-03', '20:00', 121, 81),
    ];
    expect(buildPeriodStatistics(points).insufficientData).toEqual({
      tooFewMeasurements: false,
      tooFewDays: false,
    });
  });

  it('6 измерений (ниже AI_MIN_MEASUREMENTS) → tooFewMeasurements true, дней 3 → days false', () => {
    const points = [
      point('2026-05-01', '07:00', 120, 80),
      point('2026-05-01', '20:00', 122, 81),
      point('2026-05-02', '07:00', 119, 79),
      point('2026-05-02', '20:00', 123, 82),
      point('2026-05-03', '07:00', 120, 80),
      point('2026-05-03', '20:00', 121, 81),
    ];
    expect(buildPeriodStatistics(points).insufficientData).toEqual({
      tooFewMeasurements: true,
      tooFewDays: false,
    });
    expect(points.length).toBe(AI_MIN_MEASUREMENTS - 1);
  });

  it('дней 2 (ниже AI_MIN_DAYS) → tooFewDays true (пороги из kernel)', () => {
    const points = [
      point('2026-05-01', '07:00', 120, 80, 60),
      point('2026-05-01', '08:00', 121, 81, 61),
      point('2026-05-01', '19:00', 122, 82, 62),
      point('2026-05-01', '20:00', 123, 80, 63),
      point('2026-05-01', '21:00', 124, 81, 64),
      point('2026-05-01', '22:00', 125, 82, 65),
      point('2026-05-02', '07:00', 126, 83, 66),
    ];
    expect(buildPeriodStatistics(points).insufficientData).toEqual({
      tooFewMeasurements: false,
      tooFewDays: true,
    });
    expect(AI_MIN_DAYS).toBe(3);
  });
});

describe('buildPeriodStatistics — SD n=1/n=2 и delta (AC §20, §13)', () => {
  it('одна запись → SD undefined везде (n=1), delta undefined (вечера нет)', () => {
    const stats = buildPeriodStatistics([point('2026-05-01', '07:00', 123, 84, 70)]);
    expect(stats.sys).toEqual({ avg: 123, min: 123, max: 123, sd: undefined });
    expect(stats.pulse).toEqual({ avg: 70, min: 70, max: 70, sd: undefined });
    expect(stats.morning?.sys.sd).toBeUndefined();
    expect(stats.evening).toBeUndefined();
    expect(stats.delta).toBeUndefined();
    expect(stats.daysWithMeasurements).toBe(1);
    expect(stats.longestStreakDays).toBe(1);
  });

  it('n=2 → SD вычислен: [120,130] → 7.1 (эталон AC)', () => {
    const stats = buildPeriodStatistics([
      point('2026-05-01', '07:00', 120, 80),
      point('2026-05-01', '08:00', 130, 82),
    ]);
    expect(stats.sys.sd).toBe(7.1);
    expect(stats.dia.sd).toBe(1.4);
  });

  it('только вечер → delta undefined (нужны ОБЕ части, §13), evening определена', () => {
    const stats = buildPeriodStatistics([
      point('2026-05-01', '19:00', 128, 83, 66),
      point('2026-05-02', '20:00', 130, 85, 70),
    ]);
    expect(stats.morning).toBeUndefined();
    expect(stats.evening).toBeDefined();
    expect(stats.delta).toBeUndefined();
  });
});

describe('buildPeriodStatistics — критические значения и прочие поля (§7)', () => {
  it('только high → {high:true, low:false}; только low → {high:false, low:true}', () => {
    const highOnly = buildPeriodStatistics([
      point('2026-05-01', '07:00', 185, 100, undefined, 'high'),
    ]);
    expect(highOnly.critical).toEqual({ high: true, low: false });
    const lowOnly = buildPeriodStatistics([point('2026-05-01', '07:00', 85, 55, undefined, 'low')]);
    expect(lowOnly.critical).toEqual({ high: false, low: true });
  });

  it('lastMeasurementUtcMs — максимум по utcMs, НЕ последняя по списку (порядок входа любой)', () => {
    const later = point('2026-05-02', '20:00', 120, 80);
    const earlier = point('2026-05-01', '07:00', 121, 81);
    expect(buildPeriodStatistics([later, earlier]).lastMeasurementUtcMs).toBe(later.takenAt.utcMs);
    expect(buildPeriodStatistics([earlier, later]).lastMeasurementUtcMs).toBe(later.takenAt.utcMs);
  });
});

describe('buildPeriodStatistics — classification (TASK-053 §5, аддитивно)', () => {
  it('без шкалы поля classification нет (расширение вызова аддитивно, §5)', () => {
    const stats = buildPeriodStatistics([point('2026-05-01', '07:00', 120, 80)]);
    expect('classification' in stats).toBe(false);
  });

  it('фикстура (b) onlyMorning + шкала → classification заполнена: мало данных → без категории (AC §20 п. 5)', () => {
    const stats = buildPeriodStatistics(fixture('onlyMorning').points(), BP_OFFICE_ESC2018);
    expect(stats.insufficientData.tooFewMeasurements).toBe(true);
    expect(stats.classification).toEqual({
      category: undefined,
      notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
    });
  });

  it('фикстура (a) classic30 + шкала → normal + обе заметки (округлённые avg 121.5/80.8 — как есть, §13)', () => {
    const stats = buildPeriodStatistics(fixture('classic30').points(), BP_OFFICE_ESC2018);
    expect(stats.classification?.category?.code).toBe('normal');
    expect(stats.classification?.notes).toEqual([
      { kind: 'homeBP', text: BP_OFFICE_ESC2018.homeBPNote },
      { kind: 'specialGroups', text: BP_OFFICE_ESC2018.specialGroupsNote },
    ]);
  });

  it('фикстура (d) threeRecords (3 записи) → category undefined + note insufficientData (AC §20 п. 3)', () => {
    const stats = buildPeriodStatistics(fixture('threeRecords').points(), BP_OFFICE_ESC2018);
    expect(stats.insufficientData).toEqual({ tooFewMeasurements: true, tooFewDays: true });
    expect(stats.classification).toEqual({
      category: undefined,
      notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
    });
  });

  it('пустой период + шкала → insufficientData-note без категории (обе tooFew true)', () => {
    const stats = buildPeriodStatistics([], BP_OFFICE_ESC2018);
    expect(stats.classification).toEqual({
      category: undefined,
      notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
    });
  });

  it('ровно пороги kernel (7 измерений, 3 дня) → категория появляется (граница включительно)', () => {
    const points = [
      point('2026-05-01', '07:00', 120, 80),
      point('2026-05-01', '20:00', 122, 81),
      point('2026-05-01', '21:00', 121, 80),
      point('2026-05-02', '07:00', 119, 79),
      point('2026-05-02', '20:00', 123, 82),
      point('2026-05-03', '07:00', 120, 80),
      point('2026-05-03', '20:00', 121, 81),
    ];
    const stats = buildPeriodStatistics(points, BP_OFFICE_ESC2018);
    expect(stats.insufficientData).toEqual({ tooFewMeasurements: false, tooFewDays: false });
    // avg 120.9/80.4 → normal.
    expect(stats.classification?.category?.code).toBe('normal');
  });
});

describe('buildPeriodStatistics — свойства §19 (fast-check)', () => {
  it('перестановка записей не меняет структуру (все агрегаты порядок-инвариантны)', () => {
    fc.assert(
      fc.property(
        fc.array(pointArb, { maxLength: 60 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (points, seed) => {
          expect(buildPeriodStatistics(shuffled(points, seed))).toEqual(
            buildPeriodStatistics(points),
          );
        },
      ),
    );
  });

  it('добавление записи не уменьшает count и дни с измерениями (§19)', () => {
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 60 }), pointArb, (points, extra) => {
        const before = buildPeriodStatistics(points);
        const after = buildPeriodStatistics([...points, extra]);
        expect(after.count).toBeGreaterThanOrEqual(before.count);
        expect(after.daysWithMeasurements).toBeGreaterThanOrEqual(before.daysWithMeasurements);
      }),
    );
  });

  it('NaN-свобода: ни одно числовое поле структуры не NaN (§19/AC §20 п. 2)', () => {
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 80 }), (points) => {
        expect(nanPaths(buildPeriodStatistics(points))).toEqual([]);
      }),
    );
  });

  it('avg в пределах [min, max], когда определены (санитарное свойство)', () => {
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 60 }), (points) => {
        const stats = buildPeriodStatistics(points);
        for (const channel of [
          stats.sys,
          stats.dia,
          stats.pulse,
          stats.morning?.sys,
          stats.morning?.dia,
          stats.evening?.sys,
          stats.evening?.dia,
          stats.other?.sys,
          stats.other?.dia,
        ]) {
          if (channel === undefined || channel.avg === undefined) {
            continue;
          }
          expect(channel.avg).toBeGreaterThanOrEqual(channel.min as number);
          expect(channel.avg).toBeLessThanOrEqual(channel.max as number);
        }
      }),
    );
  });
});
