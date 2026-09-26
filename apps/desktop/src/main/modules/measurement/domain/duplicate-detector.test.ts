// TASK-019 §19: граничные кейсы окна (Δ = окно−1 с / ровно окно / окно+1 с / окно+1 мс:
// ≤ включительно — ровно 120 000 мс дубль, 120 001 — нет, §13/§20), совпадение только
// одного поля → false, пустой recent → false, рука left/right с одинаковыми значениями
// → true (задокументированное решение §13: правило по значениям, рука игнорируется),
// «ночная/утренняя» через 8 часов → false. Property fast-check: перестановка recent и
// симметрия Δ (кандидат до/после записи) не меняют результат (abs-правило, §7).
// Детектор — pure: окно истории отсекает use case (TASK-029), сюда приходит готовый
// recent (~10 записей, §7).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FixedClock, unsafeUnwrap } from '@hl/kernel';

import { BpMeasurement } from './bp-measurement.js';
import { DUPLICATE_WINDOW_MS } from './constants.js';
import { detectDuplicate } from './duplicate-detector.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const clockNow = new FixedClock(NOW_MS, TZ);

/** Запись recent: момент utcMs (≤ «сейчас» Clock'а), рука — по умолчанию left. */
const record = (sys: number, dia: number, utcMs: number, arm: 'left' | 'right' = 'left'): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys,
        dia,
        irregularPulse: false,
        arm,
        takenAt: { utcMs, tzOffsetMin: TZ },
      },
      clockNow,
    ),
  );

/** База golden-кейсов: единственная запись 128/82 за 10 минут до «сейчас». */
const BASE_MS = NOW_MS - 10 * MINUTE_MS;

describe('detectDuplicate — граничные кейсы окна (§19/§20)', () => {
  it('те же значения, Δ = окно − 1 с (119 с) → true (§20)', () => {
    expect(
      detectDuplicate([record(128, 82, BASE_MS)], {
        sys: 128,
        dia: 82,
        utcMs: BASE_MS + DUPLICATE_WINDOW_MS - 1_000,
      }),
    ).toBe(true);
  });

  it('те же значения, Δ ровно = окно (120 с = 120 000 мс) → true: граница включительно (§13/§20)', () => {
    expect(
      detectDuplicate([record(128, 82, BASE_MS)], {
        sys: 128,
        dia: 82,
        utcMs: BASE_MS + DUPLICATE_WINDOW_MS,
      }),
    ).toBe(true);
  });

  it('те же значения, Δ = окно + 1 с (121 с) → false (§20)', () => {
    expect(
      detectDuplicate([record(128, 82, BASE_MS)], {
        sys: 128,
        dia: 82,
        utcMs: BASE_MS + DUPLICATE_WINDOW_MS + 1_000,
      }),
    ).toBe(false);
  });

  it('те же значения, Δ = окно + 1 мс (120 001 мс) → false (§19)', () => {
    expect(
      detectDuplicate([record(128, 82, BASE_MS)], {
        sys: 128,
        dia: 82,
        utcMs: BASE_MS + DUPLICATE_WINDOW_MS + 1,
      }),
    ).toBe(false);
  });

  it('симметрия abs: кандидат на минуту РАНЬШЕ записи → true (§7: abs, двойной Enter в обе стороны)', () => {
    expect(
      detectDuplicate([record(128, 82, BASE_MS)], {
        sys: 128,
        dia: 82,
        utcMs: BASE_MS - 1 * MINUTE_MS,
      }),
    ).toBe(true);
  });
});

describe('detectDuplicate — совпадение значений (§19/§20)', () => {
  it('только dia совпал (sys другой) → false (§19)', () => {
    expect(
      detectDuplicate([record(120, 82, BASE_MS)], { sys: 128, dia: 82, utcMs: BASE_MS }),
    ).toBe(false);
  });

  it('только sys совпал (dia другой) → false (§20)', () => {
    expect(
      detectDuplicate([record(128, 90, BASE_MS)], { sys: 128, dia: 82, utcMs: BASE_MS }),
    ).toBe(false);
  });

  it('та же пара значений у другой руки (left → right) → true: рука игнорируется (задокументированное решение §13)', () => {
    expect(
      detectDuplicate([record(128, 82, BASE_MS, 'right')], {
        sys: 128,
        dia: 82,
        utcMs: BASE_MS,
      }),
    ).toBe(true);
  });

  it('«ночная» запись и «утренняя такая же» через 8 часов → false (окно, §13)', () => {
    expect(
      detectDuplicate([record(128, 82, NOW_MS - 8 * HOUR_MS)], {
        sys: 128,
        dia: 82,
        utcMs: NOW_MS,
      }),
    ).toBe(false);
  });
});

describe('detectDuplicate — пустой recent (§19/§20)', () => {
  it('пустая история → false (не с чем сравнивать)', () => {
    expect(detectDuplicate([], { sys: 128, dia: 82, utcMs: BASE_MS })).toBe(false);
  });
});

describe('Property-тесты (fast-check, §19)', () => {
  /** Парет генератор: валидная пара давления (sys > dia) — диапазоны VO TASK-016. */
  const bpPair = fc
    .tuple(fc.integer({ min: 90, max: 180 }), fc.integer({ min: 50, max: 95 }))
    .filter(([sys, dia]) => sys > dia);

  const historyArb = fc.array(bpPair, { minLength: 0, maxLength: 10 });

  /** Детерминированная перестановка Фишера–Йетса (фиксированный сид LCG). */
  const permute = <T>(items: T[]): T[] => {
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  it('перестановка recent не меняет результат (some порядок-инвариантен, §15)', () => {
    fc.assert(
      fc.property(historyArb, bpPair, fc.integer({ min: -5, max: 5 }), (pairs, candidate, offsetMin) => {
        const recent = pairs.map(([sys, dia], i) => record(sys, dia, BASE_MS - (i + 1) * MINUTE_MS));
        const permuted = permute(recent);
        const candidateArg = {
          sys: candidate[0],
          dia: candidate[1],
          utcMs: BASE_MS + offsetMin * MINUTE_MS,
        };

        expect(detectDuplicate(permuted, candidateArg)).toBe(detectDuplicate(recent, candidateArg));
      }),
    );
  });

  it('симметрия Δ: кандидат за d мс до и за d мс после записи дают одинаковый результат (abs-правило, §7)', () => {
    fc.assert(
      fc.property(
        bpPair,
        bpPair,
        fc.integer({ min: -3 * DUPLICATE_WINDOW_MS, max: 3 * DUPLICATE_WINDOW_MS }),
        (recordPair, candidate, delta) => {
          const [sys, dia] = recordPair;
          const single = record(sys, dia, BASE_MS);
          const before = { sys: candidate[0], dia: candidate[1], utcMs: BASE_MS - delta };
          const after = { sys: candidate[0], dia: candidate[1], utcMs: BASE_MS + delta };

          expect(detectDuplicate([single], before)).toBe(detectDuplicate([single], after));
        },
      ),
    );
  });
});
