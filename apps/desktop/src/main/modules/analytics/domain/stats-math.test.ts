// TASK-052 §19: доменная математика статистики — mean/min/max/sampleSd (выборочное SD,
// знаменатель n−1, §4: «SD — выборочное (sample, n−1): зафиксировано, n<2 → SD undefined»),
// round1 (§7: «Округление avg/sd: до 1 знака») и сборка ValueStats (summarize).
// Эталоны перепроверены вторым способом (скрипт пересчёта — §22): [120,130] →
// sd = √(50/1) ≈ 7.0711 → 7.1; [10,12,14] → sd = √(8/2) = 2; [1,2,3,4] →
// sd = √(5/3) ≈ 1.2910 → 1.3. Пустой вход → undefined (НЕ NaN — AC §20), число
// усреднений нет. Функции чистые (арх. 02 §5): только аргументы, без времени и I/O.
import { describe, expect, it } from 'vitest';

import {
  criticalPeriodFlag,
  difference,
  mean,
  max,
  min,
  round1,
  sampleSd,
  summarize,
} from './stats-math.js';

describe('mean — среднее арифметическое (§5)', () => {
  it('пустой набор → undefined (не NaN — AC §20)', () => {
    expect(mean([])).toBeUndefined();
  });

  it('одна запись → само значение', () => {
    expect(mean([120])).toBe(120);
  });

  it('несколько записей → среднее (дробное без округления)', () => {
    expect(mean([10, 12, 14])).toBe(12);
    expect(mean([1, 2])).toBe(1.5);
  });
});

describe('min/max — минимум и максимум (§5)', () => {
  it('пустой набор → undefined (не NaN — AC §20)', () => {
    expect(min([])).toBeUndefined();
    expect(max([])).toBeUndefined();
  });

  it('одна запись → само значение', () => {
    expect(min([120])).toBe(120);
    expect(max([120])).toBe(120);
  });

  it('не отсортированный набор → крайние значения', () => {
    expect(min([122, 118, 126])).toBe(118);
    expect(max([122, 118, 126])).toBe(126);
  });
});

describe('sampleSd — выборочное SD (n−1, §4/§13)', () => {
  it('пустой набор → undefined (§4: n<2 → undefined)', () => {
    expect(sampleSd([])).toBeUndefined();
  });

  it('n=1 → undefined (§13/AC: SD при n=1 → undefined)', () => {
    expect(sampleSd([120])).toBeUndefined();
  });

  it('n=2 → вычислено (эталон AC): [120,130] → √50 ≈ 7.0710678…', () => {
    expect(sampleSd([120, 130])).toBeCloseTo(7.0710678, 6);
  });

  it('эталон [10,12,14] → 2 (девиации −2/0/2, сумма квадратов 8, знаменатель 2)', () => {
    expect(sampleSd([10, 12, 14])).toBe(2);
  });

  it('эталон [1,2,3,4] → √(5/3) ≈ 1.291 (нечётная девиация)', () => {
    expect(sampleSd([1, 2, 3, 4])).toBeCloseTo(1.2909944, 6);
  });
});

describe('round1 — округление до 1 знака (§7, правило отображения)', () => {
  it('целое не меняется', () => {
    expect(round1(122)).toBe(122);
  });

  it('дробное ужимается до 1 знака', () => {
    expect(round1(80.75)).toBe(80.8);
    expect(round1(7.0710678)).toBe(7.1);
    expect(round1(1.2909944)).toBe(1.3);
  });

  it('второй знак < 5 отбрасывается', () => {
    expect(round1(0.713)).toBe(0.7);
  });
});

describe('summarize — сборка ValueStats (avg/sd округлены до 1 знака, §7)', () => {
  it('пустой набор → все поля undefined (AC: пустой период без NaN)', () => {
    expect(summarize([])).toEqual({
      avg: undefined,
      min: undefined,
      max: undefined,
      sd: undefined,
    });
  });

  it('n=1 → avg/min/max = значение, sd undefined (§13)', () => {
    expect(summarize([120])).toEqual({ avg: 120, min: 120, max: 120, sd: undefined });
  });

  it('n=2 → sd вычислен и округлён: [120,130] → avg 125, sd 7.1 (эталон AC)', () => {
    expect(summarize([120, 130])).toEqual({ avg: 125, min: 120, max: 130, sd: 7.1 });
  });

  it('min/max не округляются (вход целочисленный), avg/sd — до 1 знака', () => {
    const stats = summarize([80, 81, 82]);
    expect(stats.min).toBe(80);
    expect(stats.max).toBe(82);
    expect(stats.avg).toBe(81);
    expect(stats.sd).toBe(1);
  });
});

describe('difference — вечер минус утро (§5/§13)', () => {
  it('эталон: утро 120.5/80.5, вечер 122.5/81 → 2 / 0.5 (§19, фикс. (a))', () => {
    expect(difference({ sys: 120.5, dia: 80.5 }, { sys: 122.5, dia: 81 })).toEqual({
      sys: 2,
      dia: 0.5,
    });
  });

  it('вечер ниже утра → отрицательная разница (клинически валидна)', () => {
    expect(difference({ sys: 130, dia: 85 }, { sys: 122, dia: 80 })).toEqual({
      sys: -8,
      dia: -5,
    });
  });

  it('дробный результат округляется до 1 знака (§7)', () => {
    expect(difference({ sys: 120.55, dia: 80 }, { sys: 122.51, dia: 81.13 })).toEqual({
      sys: 2,
      dia: 1.1,
    });
  });
});

describe('criticalPeriodFlag — были ли high/low за период (§5, политика TASK-020)', () => {
  it('пустой период → оба false (не undefined — булевы поля §7)', () => {
    expect(criticalPeriodFlag([])).toEqual({ high: false, low: false });
  });

  it('флагов нет → оба false (фикс. (a)–(d))', () => {
    expect(criticalPeriodFlag([undefined, undefined, undefined])).toEqual({
      high: false,
      low: false,
    });
  });

  it('только high → {high: true, low: false}', () => {
    expect(criticalPeriodFlag([undefined, 'high', undefined])).toEqual({ high: true, low: false });
  });

  it('только low → {high: false, low: true}', () => {
    expect(criticalPeriodFlag([undefined, 'low'])).toEqual({ high: false, low: true });
  });

  it('оба типа в периоде → оба true (фикс. (e))', () => {
    expect(criticalPeriodFlag(['high', undefined, 'low'])).toEqual({ high: true, low: true });
  });
});
