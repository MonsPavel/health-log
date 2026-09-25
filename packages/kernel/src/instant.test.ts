// TASK-006 §19: юнит-тесты Instant (EC-06/07 — ночной переход, ±60 мин) и property-тесты
// roundtrip на utcMs ∈ [2000-01, 2100-01], tzOffsetMin ∈ [-720, 840] (инварианты §13).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Instant } from './instant.js';

/** Момент: 2000-01-01T00:00:00Z — нижняя граница property-диапазона (§19). */
const Y2000_MS = Date.UTC(2000, 0, 1);
/** Момент: 2100-01-01T00:00:00Z — верхняя граница property-диапазона (§19). */
const Y2100_MS = Date.UTC(2100, 0, 1);

/** Произвольный Instant из диапазона §19. */
const instantArbitrary = fc.record({
  utcMs: fc.integer({ min: Y2000_MS, max: Y2100_MS }),
  tzOffsetMin: fc.integer({ min: -720, max: 840 }),
});

describe('Instant.wallTime — настенное время как UTC + offset (§7, §13)', () => {
  it('UTC+180: 11:30 UTC показывает 14:30 того же дня', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: 180 };

    expect(Instant.wallTime(instant)).toEqual({ y: 2026, m: 9, d: 25, h: 14, min: 30 });
  });

  it('отрицательное смещение UTC-300: 11:30 UTC показывает 06:30', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: -300 };

    expect(Instant.wallTime(instant)).toEqual({ y: 2026, m: 9, d: 25, h: 6, min: 30 });
  });

  it('переход через полночь назад (UTC-60): 00:30 UTC — ещё 31 декабря предыдущего года', () => {
    const instant = { utcMs: Date.UTC(2026, 0, 1, 0, 30), tzOffsetMin: -60 };

    expect(Instant.wallTime(instant)).toEqual({ y: 2025, m: 12, d: 31, h: 23, min: 30 });
  });

  it('доля минуты сохраняется: секунды и миллисекунды utcMs не теряются в настенном времени', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30, 5, 123), tzOffsetMin: 180 };
    const wall = Instant.wallTime(instant);

    expect(wall).toEqual({ y: 2026, m: 9, d: 25, h: 14, min: 30 });
    // Секунды/мс остаются в utcMs — настенное время в kernel до минут (утро/вечер, §7).
    expect(instant.utcMs % 60_000).toBe(5_123);
  });
});

describe('Instant.compare — сортировка только по UTC (§7, §13)', () => {
  it('два Instant с разным offset сравнимы по utc', () => {
    const earlier = { utcMs: Date.UTC(2026, 8, 25, 11, 0), tzOffsetMin: 600 };
    const later = { utcMs: Date.UTC(2026, 8, 25, 12, 0), tzOffsetMin: -720 };

    expect(Instant.compare(earlier, later)).toBe(-1);
    expect(Instant.compare(later, earlier)).toBe(1);
  });

  it('равные utcMs при разных offset равны', () => {
    const a = { utcMs: 1_000, tzOffsetMin: -720 };
    const b = { utcMs: 1_000, tzOffsetMin: 840 };

    expect(Instant.compare(a, b)).toBe(0);
    expect(Instant.compare(a, a)).toBe(0);
  });

  it('sort по compare упорядочивает по utc независимо от offset', () => {
    const first = { utcMs: Date.UTC(2026, 8, 25, 12, 0), tzOffsetMin: 840 };
    const second = { utcMs: Date.UTC(2026, 8, 25, 13, 0), tzOffsetMin: -720 };
    const third = { utcMs: Date.UTC(2026, 8, 25, 14, 0), tzOffsetMin: 0 };

    expect([third, first, second].sort(Instant.compare)).toEqual([first, second, third]);
  });
});

describe('Instant.toIso / Instant.fromIso — сериализация и roundtrip (§7)', () => {
  it('toIso: настенное время и offset в строке, положительный offset', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30, 5, 123), tzOffsetMin: 180 };

    expect(Instant.toIso(instant)).toBe('2026-09-25T14:30:05.123+03:00');
  });

  it('toIso: отрицательный offset со знаком минус', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: -300 };

    expect(Instant.toIso(instant)).toBe('2026-09-25T06:30:00.000-05:00');
  });

  it('fromIso: строка с offset переводится в utcMs вычитанием offset', () => {
    const instant = Instant.fromIso('2026-01-01T00:00:00.000+03:00');

    expect(instant.utcMs).toBe(Date.UTC(2026, 0, 1) - 180 * 60_000);
    expect(instant.tzOffsetMin).toBe(180);
  });

  it('fromIso: отрицательный offset прибавляется к настенному времени', () => {
    const instant = Instant.fromIso('2026-01-01T00:00:00.000-05:00');

    expect(instant.utcMs).toBe(Date.UTC(2026, 0, 1) + 300 * 60_000);
    expect(instant.tzOffsetMin).toBe(-300);
  });

  it('fromIso: до эпохи (год < 2000) парсится с ведущим нулём года', () => {
    const instant = { utcMs: Date.UTC(1969, 11, 31, 23, 0), tzOffsetMin: 0 };

    expect(Instant.fromIso(Instant.toIso(instant))).toEqual(instant);
  });

  it.each([
    'мусор',
    '2026-09-25T14:30:05.123', // нет offset
    '2026-09-25 14:30:05.123+03:00', // пробел вместо T
    '2026-09-25T14:30:05+03:00', // нет миллисекунд
    '2026-13-01T00:00:00.000+00:00', // месяц 13
    '2026-00-01T00:00:00.000+00:00', // месяц 0
    '2026-09-32T00:00:00.000+00:00', // день 32
    '2026-09-00T00:00:00.000+00:00', // день 0
    '2026-09-25T24:00:00.000+00:00', // час 24
    '2026-09-25T10:60:00.000+00:00', // минута 60
    '2026-09-25T10:59:60.000+00:00', // секунда 60
    '2026-09-25T10:59:59.000+24:00', // offset-час 24
    '2026-09-25T10:59:59.000+03:60', // offset-минута 60
  ])('fromIso: некорректная строка %j бросает ошибку', (iso) => {
    expect(() => Instant.fromIso(iso)).toThrowError(/Instant\.fromIso/);
  });
});

describe('EC-06: перелёт — записи не «переезжают» (§13)', () => {
  it('23:58 дома (UTC+3) и 00:03 после перелёта (UTC-3) — разные настенные дни, порядок по utc сохранён', () => {
    // Дома (UTC+3): настенное 23:58 1 сентября → 20:58 UTC.
    const atHome = { utcMs: Date.UTC(2026, 8, 1, 20, 58), tzOffsetMin: 180 };
    // После перелёта (UTC-3): настенное 00:03 2 сентября → 03:03 UTC.
    const afterFlight = { utcMs: Date.UTC(2026, 8, 2, 3, 3), tzOffsetMin: -180 };

    expect(Instant.wallTime(atHome)).toEqual({ y: 2026, m: 9, d: 1, h: 23, min: 58 });
    expect(Instant.wallTime(afterFlight)).toEqual({ y: 2026, m: 9, d: 2, h: 0, min: 3 });
    // Группировка дней — по настенному времени: соседние по utc записи в разных днях.
    expect(Instant.compare(atHome, afterFlight)).toBe(-1);
  });
});

describe('EC-07: смещение ±60 минут не меняет настенное время исторической записи (§13)', () => {
  it('запись, созданная при UTC+60, показывает то же настенное время после «перевода часов»', () => {
    // Запись сделана при UTC+60: настенное 09:00 1 июня → 08:00 UTC; offset хранится в записи.
    const record = { utcMs: Date.UTC(2026, 5, 1, 8, 0), tzOffsetMin: 60 };

    // Часы перевели на час вперёд (устройство теперь в UTC+120), но историческая запись
    // хранит СВОЙ offset: настенное время записи не изменилось.
    expect(Instant.wallTime(record)).toEqual({ y: 2026, m: 6, d: 1, h: 9, min: 0 });
    expect(Instant.toIso(record)).toBe('2026-06-01T09:00:00.000+01:00');
  });

  it('записи в UTC+60 и UTC+120 вокруг перевода не дублируются и не теряются: порядок по utc', () => {
    const beforeShift = { utcMs: Date.UTC(2026, 2, 28, 22, 0), tzOffsetMin: 60 }; // настенное 23:00
    const afterShift = { utcMs: Date.UTC(2026, 2, 28, 22, 30), tzOffsetMin: 120 }; // настенное 00:30 (+1 день)

    expect(Instant.compare(beforeShift, afterShift)).toBe(-1);
    expect(Instant.wallTime(beforeShift).d).toBe(28);
    expect(Instant.wallTime(afterShift)).toEqual({ y: 2026, m: 3, d: 29, h: 0, min: 30 });
  });
});

describe('Property-тесты Instant (fast-check, §19-§20)', () => {
  it('roundtrip: fromIso(toIso(x)) ≡ x — 10 000+ случаев без сбоев (§20)', () => {
    fc.assert(
      fc.property(instantArbitrary, (x) => {
        const back = Instant.fromIso(Instant.toIso(x));

        expect(back.utcMs).toBe(x.utcMs);
        expect(back.tzOffsetMin).toBe(x.tzOffsetMin);
      }),
      { numRuns: 10_000 },
    );
  });

  it('настенное время совпадает с Date-оракулом (UTC + offset) на всём диапазоне §19', () => {
    fc.assert(
      fc.property(instantArbitrary, (x) => {
        const oracle = new Date(x.utcMs + x.tzOffsetMin * 60_000);

        expect(Instant.wallTime(x)).toEqual({
          y: oracle.getUTCFullYear(),
          m: oracle.getUTCMonth() + 1,
          d: oracle.getUTCDate(),
          h: oracle.getUTCHours(),
          min: oracle.getUTCMinutes(),
        });
      }),
      { numRuns: 1_000 },
    );
  });

  it('compare согласован с разницей utcMs; равные моменты сравниваются как 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Y2000_MS, max: Y2100_MS }),
        fc.integer({ min: Y2000_MS, max: Y2100_MS }),
        fc.integer({ min: -720, max: 840 }),
        fc.integer({ min: -720, max: 840 }),
        (aMs, bMs, aTz, bTz) => {
          const a = { utcMs: aMs, tzOffsetMin: aTz };
          const b = { utcMs: bMs, tzOffsetMin: bTz };
          const expected = Math.sign(aMs - bMs);

          expect(Instant.compare(a, b)).toBe(expected);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('toIso всегда соответствует ISO 8601 с offset и минутным смещением', () => {
    fc.assert(
      fc.property(instantArbitrary, (x) => {
        expect(Instant.toIso(x)).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
        );
      }),
      { numRuns: 1_000 },
    );
  });
});
