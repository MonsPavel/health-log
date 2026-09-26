// TASK-018 §19: golden-кейсы (история 14×128/82, кандидаты 128/168/169/258; ровно 40 —
// нет флага, 41 — флаг: строгое сравнение §13), устойчивость медианы к скрытой опечатке
// в истории, чётная/нечётная длина (кейсы 3 и 4 записей, стандартное определение медианы),
// пустая история и 1 запись → undefined. Property fast-check: перестановка истории и
// дублирование каждой записи не меняют результат (медиана порядок-инвариантна, §19).
// Детектор — чистая математика: не знает про время (окно фильтрует use case TASK-029, §7).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FixedClock, unsafeUnwrap } from '@hl/kernel';

import { BpMeasurement } from './bp-measurement.js';
import { TYPO_WINDOW_DAYS } from './constants.js';
import { detectTypo } from './typo-heuristic.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const DAY_MS = 86_400_000;

const clockNow = new FixedClock(NOW_MS, TZ);

/** Запись истории: daysAgo дней назад, без пульса и заметки (детектору они не нужны). */
const record = (sys: number, dia: number, daysAgo: number): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys,
        dia,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs: NOW_MS - daysAgo * DAY_MS, tzOffsetMin: TZ },
      },
      clockNow,
    ),
  );

/** История «14 дней по 128/82» — базовый golden-набор §19. */
const baselineHistory = (): BpMeasurement[] =>
  Array.from({ length: TYPO_WINDOW_DAYS }, (_, i) => record(128, 82, i + 1));

describe('detectTypo — golden-кейсы §19/§20', () => {
  it('история 14×128/82, кандидат 128/82 → undefined (§19)', () => {
    expect(detectTypo(baselineHistory(), { sys: 128, dia: 82 })).toBeUndefined();
  });

  it('кандидат 168/82: отклонение ровно 40 → undefined (строгое больше, §13/§20)', () => {
    expect(detectTypo(baselineHistory(), { sys: 168, dia: 82 })).toBeUndefined();
  });

  it('кандидат 169/82: отклонение 41 → флаг sys {median 128, value 169, deviation 41} (§20)', () => {
    expect(detectTypo(baselineHistory(), { sys: 169, dia: 82 })).toEqual({
      field: 'sys',
      median: 128,
      value: 169,
      deviation: 41,
    });
  });

  it('кандидат 258/82 (персона П3, 215-стиль опечатка) → флаг sys, deviation 130 (§3)', () => {
    expect(detectTypo(baselineHistory(), { sys: 258, dia: 82 })).toEqual({
      field: 'sys',
      median: 128,
      value: 258,
      deviation: 130,
    });
  });

  it('отклонение по dia: кандидат 128/140 → флаг dia {median 82, deviation 58} (§5: поля независимо)', () => {
    expect(detectTypo(baselineHistory(), { sys: 128, dia: 140 })).toEqual({
      field: 'dia',
      median: 82,
      value: 140,
      deviation: 58,
    });
  });

  it('оба поля за порогом → флаг по худшему отклонению (sys 72 > dia 58) (§7)', () => {
    const flag = detectTypo(baselineHistory(), { sys: 200, dia: 140 });

    expect(flag?.field).toBe('sys');
    expect(flag?.deviation).toBe(72);
  });
});

describe('detectTypo — устойчивость медианы (§20)', () => {
  it('одна скрытая опечатка 258 в истории: медиана не сдвинута (128), флаг 169/82 сохраняется', () => {
    const history = [...baselineHistory(), record(258, 90, 15)];

    expect(detectTypo(history, { sys: 169, dia: 82 })).toEqual({
      field: 'sys',
      median: 128,
      value: 169,
      deviation: 41,
    });
  });
});

describe('detectTypo — медиана по стандартному определению (§20: кейсы 3 и 4 записей)', () => {
  it('нечётная длина (3 записи [120,130,200]): медиана 130 → кандидат 175/85 даёт deviation 45', () => {
    const history = [record(120, 80, 3), record(130, 80, 2), record(200, 80, 1)];

    expect(detectTypo(history, { sys: 175, dia: 80 })).toEqual({
      field: 'sys',
      median: 130,
      value: 175,
      deviation: 45,
    });
  });

  it('чётная длина (4 записи [120,130,140,200]): медиана = среднее центральных = 135', () => {
    const history = [
      record(120, 80, 4),
      record(130, 80, 3),
      record(140, 80, 2),
      record(200, 80, 1),
    ];

    // 175 − 135 = 40 → ровно порог, флага нет (§13); 176 − 135 = 41 → флаг с медианой 135.
    expect(detectTypo(history, { sys: 175, dia: 80 })).toBeUndefined();
    expect(detectTypo(history, { sys: 176, dia: 80 })).toEqual({
      field: 'sys',
      median: 135,
      value: 176,
      deviation: 41,
    });
  });
});

describe('detectTypo — нет базы сравнения (§13/§20)', () => {
  it('пустая история → undefined', () => {
    expect(detectTypo([], { sys: 258, dia: 200 })).toBeUndefined();
  });

  it('одна запись → undefined (EC-09-дух: не подсказываем)', () => {
    expect(detectTypo([record(128, 82, 1)], { sys: 258, dia: 200 })).toBeUndefined();
  });

  it('ровно 2 записи → база есть: медиана 125, кандидат 166/80 → флаг sys (deviation 41)', () => {
    const history = [record(120, 80, 2), record(130, 80, 1)];

    expect(detectTypo(history, { sys: 166, dia: 80 })).toEqual({
      field: 'sys',
      median: 125,
      value: 166,
      deviation: 41,
    });
  });
});

describe('Property-тесты (fast-check, §19)', () => {
  /** Парет генератор: валидная пара давления (sys > dia) — диапазоны VO TASK-016. */
  const bpPair = fc
    .tuple(fc.integer({ min: 90, max: 180 }), fc.integer({ min: 50, max: 95 }))
    .filter(([sys, dia]) => sys > dia);

  const historyArb = fc.array(bpPair, { minLength: 0, maxLength: 15 });

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

  it('перестановка истории не меняет результат (медиана порядок-инвариантна, §19)', () => {
    fc.assert(
      fc.property(historyArb, bpPair, (pairs, candidate) => {
        const history = pairs.map(([sys, dia], i) => record(sys, dia, i + 1));
        const permuted = permute(history);

        expect(detectTypo(permuted, { sys: candidate[0], dia: candidate[1] })).toEqual(
          detectTypo(history, { sys: candidate[0], dia: candidate[1] }),
        );
      }),
    );
  });

  it('дублирование каждой записи истории не меняет результат/медиану (§19)', () => {
    // minLength 2: инвариант — про медиану при наличии базы сравнения (§13: <2 записей
    // → undefined независимо от медианы; удвоение 1 записи дало бы «базу» из 2).
    fc.assert(
      fc.property(fc.array(bpPair, { minLength: 2, maxLength: 15 }), bpPair, (pairs, candidate) => {
        const history = pairs.map(([sys, dia], i) => record(sys, dia, i + 1));
        const doubled = [...history, ...history];

        expect(detectTypo(doubled, { sys: candidate[0], dia: candidate[1] })).toEqual(
          detectTypo(history, { sys: candidate[0], dia: candidate[1] }),
        );
      }),
    );
  });
});
