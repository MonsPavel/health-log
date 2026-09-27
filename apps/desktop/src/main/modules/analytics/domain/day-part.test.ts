// TASK-052 §19/§13: day-part — привязка измерения к части суток по НАСТЕННОМУ времени
// Instant (UTC + собственный offset записи — EC-06: перелёты не «перемешивают» утро
// и вечер). Таблица границ §13/AC §20: 05:59→other, 06:00→morning, 11:59→morning,
// 11:59:59→morning, 12:00→other, 18:00→evening, 23:59→evening; ночные 00:15→other
// («не вчера-вечер» §13). splitByDayPart раскладывает точки по трём частям, сохраняя
// ссылки (без копирования) и порядок. Константы окон — здесь (§5: константы домена).
import { describe, expect, it } from 'vitest';

import { Instant } from '@hl/kernel';

import { DAY_PART_WINDOWS_MIN, dayPartOf, splitByDayPart } from './day-part.js';

/** Настенный момент в UTC+3 (детерминизм NFR-10; offset записи хранится в Instant). */
const wall = (iso: string): ReturnType<typeof Instant.fromIso> => Instant.fromIso(iso);

describe('dayPartOf — таблица границ §13/AC §20 (UTC+3)', () => {
  const cases: readonly {
    readonly iso: string;
    readonly expected: string;
    readonly why: string;
  }[] = [
    { iso: '2026-03-01T05:59:00.000+03:00', expected: 'other', why: '05:59 — до окна утра' },
    { iso: '2026-03-01T05:59:59.999+03:00', expected: 'other', why: '05:59:59.999 — до окна' },
    { iso: '2026-03-01T06:00:00.000+03:00', expected: 'morning', why: 'ровно 06:00 → утро (§13)' },
    { iso: '2026-03-01T09:30:00.000+03:00', expected: 'morning', why: 'середина окна утра' },
    { iso: '2026-03-01T11:59:00.000+03:00', expected: 'morning', why: '11:59 → утро (AC §20)' },
    { iso: '2026-03-01T11:59:59.999+03:00', expected: 'morning', why: '11:59:59.999 → утро (§13)' },
    { iso: '2026-03-01T12:00:00.000+03:00', expected: 'other', why: 'ровно 12:00 → other (§13)' },
    {
      iso: '2026-03-01T17:59:59.999+03:00',
      expected: 'other',
      why: '17:59:59.999 — до окна вечера',
    },
    { iso: '2026-03-01T18:00:00.000+03:00', expected: 'evening', why: 'ровно 18:00 → вечер (§13)' },
    { iso: '2026-03-01T21:45:00.000+03:00', expected: 'evening', why: 'середина окна вечера' },
    { iso: '2026-03-01T23:59:00.000+03:00', expected: 'evening', why: '23:59 → вечер (AC §20)' },
    { iso: '2026-03-01T23:59:59.999+03:00', expected: 'evening', why: '23:59:59.999 → вечер' },
    {
      iso: '2026-03-01T00:15:00.000+03:00',
      expected: 'other',
      why: 'ночь 00:15 → other, не «вчера-вечер» (§13)',
    },
    { iso: '2026-03-01T03:00:00.000+03:00', expected: 'other', why: 'ночь 03:00 → other' },
  ];

  for (const c of cases) {
    it(`${c.iso.slice(11, 23)} → ${c.expected} (${c.why})`, () => {
      expect(dayPartOf(wall(c.iso))).toBe(c.expected);
    });
  }
});

describe('dayPartOf — настенное время записи, не UTC и не текущий пояс (EC-06)', () => {
  it('06:00 в UTC−5 → morning (offset записи −300)', () => {
    expect(dayPartOf(wall('2026-03-01T06:00:00.000-05:00'))).toBe('morning');
  });

  it('12:00 в UTC−5 → other (не morning по UTC: 17:00 UTC)', () => {
    expect(dayPartOf(wall('2026-03-01T12:00:00.000-05:00'))).toBe('other');
  });

  it('18:00 в UTC+0 → evening; 18:00 UTC+3 (= 15:00 UTC) → evening по настенным 18:00', () => {
    expect(dayPartOf(wall('2026-03-01T18:00:00.000+00:00'))).toBe('evening');
    expect(dayPartOf(wall('2026-03-01T18:00:00.000+03:00'))).toBe('evening');
  });
});

describe('splitByDayPart — раскладка точек по частям суток (§5)', () => {
  interface Point {
    readonly id: string;
    readonly takenAt: ReturnType<typeof Instant.fromIso>;
  }

  const point = (id: string, iso: string): Point => ({ id, takenAt: wall(iso) });

  it('пустой вход → три пустых списка (без undefined — части фильтруются сборщиком, §13)', () => {
    expect(splitByDayPart<Point>([])).toEqual({ morning: [], evening: [], other: [] });
  });

  it('точки распределяются по окнам, ссылки сохраняются, порядок внутри части — исходный', () => {
    const morningA = point('m1', '2026-03-01T07:00:00.000+03:00');
    const morningB = point('m2', '2026-03-01T08:30:00.000+03:00');
    const eveningA = point('e1', '2026-03-01T19:00:00.000+03:00');
    const nightA = point('n1', '2026-03-01T00:15:00.000+03:00');
    const noonA = point('d1', '2026-03-01T12:00:00.000+03:00');

    const split = splitByDayPart([morningA, eveningA, nightA, morningB, noonA]);

    expect(split.morning).toEqual([morningA, morningB]);
    expect(split.evening).toEqual([eveningA]);
    expect(split.other).toEqual([nightA, noonA]);
    expect(split.morning[0]).toBe(morningA); // те же ссылки, не копии
  });

  it('окна дня (минуты) — экспортируемые константы домена (§5): 360–719 утро, 1080–1439 вечер', () => {
    expect(DAY_PART_WINDOWS_MIN).toEqual({
      morningStart: 360,
      morningEndExclusive: 720,
      eveningStart: 1080,
    });
  });
});
