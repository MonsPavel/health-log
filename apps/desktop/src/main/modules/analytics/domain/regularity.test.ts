// TASK-052 §19/§13: регулярность — уникальные настенные дни (EC-06: день считается
// по дате момента измерения с ЕГО offset) и longest streak — максимум ПОДРЯД идущих
// дней с ≥1 измерением внутри периода (§13: период замкнут, «не до сегодня»; без
// штрафов за старые пропуски FR-4.4). AC §20: записи пн, вт, чт → streak=2, дней=3.
// Чистая функция над Instant (арх. 02 §5), порядок входа не важен.
import { describe, expect, it } from 'vitest';

import { Instant } from '@hl/kernel';

import { regularity } from './regularity.js';

/** Instant из настенной ISO-строки (детерминизм NFR-10; offset остаётся в точке). */
const at = (iso: string): ReturnType<typeof Instant.fromIso> => Instant.fromIso(iso);

describe('regularity — базовые случаи (§5/§13)', () => {
  it('пустой период → 0 дней, 0 в streak', () => {
    expect(regularity([])).toEqual({ daysWithMeasurements: 0, longestStreakDays: 0 });
  });

  it('несколько записей одного дня → 1 день (уникальные дни, §5)', () => {
    const days = regularity([
      at('2026-03-02T07:00:00.000+03:00'),
      at('2026-03-02T08:00:00.000+03:00'),
      at('2026-03-02T20:00:00.000+03:00'),
    ]);
    expect(days).toEqual({ daysWithMeasurements: 1, longestStreakDays: 1 });
  });

  it('AC §20: пн, вт, чт → дней 3, streak 2 (пн-вт; чт после пропуска ср)', () => {
    const days = regularity([
      at('2026-03-02T07:00:00.000+03:00'), // пн
      at('2026-03-03T07:00:00.000+03:00'), // вт
      at('2026-03-05T07:00:00.000+03:00'), // чт (ср пропущена)
    ]);
    expect(days).toEqual({ daysWithMeasurements: 3, longestStreakDays: 2 });
  });

  it('все дни подряд → streak = числу дней', () => {
    const days = regularity([
      at('2026-03-01T07:00:00.000+03:00'),
      at('2026-03-02T07:00:00.000+03:00'),
      at('2026-03-03T07:00:00.000+03:00'),
      at('2026-03-04T07:00:00.000+03:00'),
    ]);
    expect(days).toEqual({ daysWithMeasurements: 4, longestStreakDays: 4 });
  });

  it('полностью разреженные дни → дней N, streak 1', () => {
    const days = regularity([
      at('2026-03-01T07:00:00.000+03:00'),
      at('2026-03-03T07:00:00.000+03:00'),
      at('2026-03-05T07:00:00.000+03:00'),
    ]);
    expect(days).toEqual({ daysWithMeasurements: 3, longestStreakDays: 1 });
  });

  it('два разрозненных отрезка → streak по длиннейшему (закрытый период, §13)', () => {
    // 4 дня подряд, пропуск 5 дней, снова 2 дня подряд → streak 4 (не «до сегодня»).
    const isos = [
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-09',
      '2026-03-10',
    ].map((d) => at(`${d}T08:00:00.000+03:00`));
    expect(regularity(isos)).toEqual({ daysWithMeasurements: 6, longestStreakDays: 4 });
  });

  it('порядок входа не важен (агрегат порядок-инвариантен, §19)', () => {
    const isos = [
      at('2026-03-05T07:00:00.000+03:00'),
      at('2026-03-02T07:00:00.000+03:00'),
      at('2026-03-03T07:00:00.000+03:00'),
    ];
    expect(regularity(isos)).toEqual({ daysWithMeasurements: 3, longestStreakDays: 2 });
  });
});

describe('regularity — настенный день с собственным offset записи (EC-06)', () => {
  it('поздний вечер +03:00 и утро следующего настенного дня → 2 дня, streak 2', () => {
    const days = regularity([
      at('2026-03-01T23:30:00.000+03:00'),
      at('2026-03-02T08:00:00.000+03:00'),
    ]);
    expect(days).toEqual({ daysWithMeasurements: 2, longestStreakDays: 2 });
  });

  it('два момента одной настенной даты в разных поясах → 1 день', () => {
    const days = regularity([
      at('2026-03-01T23:30:00.000+03:00'), // настенное 1 марта, 23:30
      at('2026-03-01T01:30:00.000-05:00'), // настенное тоже 1 марта, 01:30
    ]);
    expect(days).toEqual({ daysWithMeasurements: 1, longestStreakDays: 1 });
  });

  it('граница суток по настенной минуте: 23:59 и 00:01 следующего дня → 2 дня', () => {
    const days = regularity([
      at('2026-03-01T23:59:00.000+03:00'),
      at('2026-03-02T00:01:00.000+03:00'),
    ]);
    expect(days).toEqual({ daysWithMeasurements: 2, longestStreakDays: 2 });
  });
});
