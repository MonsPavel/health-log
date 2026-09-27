/**
 * TASK-040 §13/§19: таблица кейсов умной вставки пары «120/80» — исчерпывающе:
 * разделители / , ; - и пробел, трим по краям, границы домена (50–300 / 20–200),
 * мусор («не помню», «1a2»), >3 цифр, одиночное число (не пара).
 */
import { describe, expect, it } from 'vitest';

import { parseBpPair } from './parse-bp-pair';

describe('parseBpPair — распознанные пары (§13)', () => {
  it.each([
    ['120/80', { sys: 120, dia: 80 }],
    ['120, 80', { sys: 120, dia: 80 }],
    ['120 80', { sys: 120, dia: 80 }],
    ['120;80', { sys: 120, dia: 80 }],
    ['120-80', { sys: 120, dia: 80 }],
    ['125/ 82', { sys: 125, dia: 82 }],
    [' 120/80 ', { sys: 120, dia: 80 }],
    ['120\t80', { sys: 120, dia: 80 }],
    ['50/20', { sys: 50, dia: 20 }],
    ['300/200', { sys: 300, dia: 200 }],
  ])('«%s» → %j', (text, expected) => {
    expect(parseBpPair(text)).toEqual(expected);
  });
});

describe('parseBpPair — границы домена (§7: оба числа в 50–300 / 20–200)', () => {
  it.each([
    ['49/80', 'sys < 50'],
    ['301/80', 'sys > 300'],
    ['120/19', 'dia < 20'],
    ['120/201', 'dia > 200'],
  ])('«%s» (%s) → undefined', (text) => {
    expect(parseBpPair(text)).toBeUndefined();
  });
});

describe('parseBpPair — не пара (§13: одиночное число — штатная вставка, не пара)', () => {
  it.each([['125'], ['12'], ['7'], [' 120 ']])('«%s» → undefined', (text) => {
    expect(parseBpPair(text)).toBeUndefined();
  });
});

describe('parseBpPair — мусор (§13: undefined + тост на стороне формы)', () => {
  it.each([
    ['не помню'],
    ['1a2'],
    ['1200/80'],
    ['1200 80'],
    ['120/801'],
    ['120/80/90'],
    ['120/80abc'],
    ['abc'],
    [''],
    ['   '],
    ['/'],
    ['12/'],
    ['/80'],
  ])('«%s» → undefined', (text) => {
    expect(parseBpPair(text)).toBeUndefined();
  });

  it('ведущие нули: «080/060» → числа 80 и 60 (строки цифр соберёт форма)', () => {
    expect(parseBpPair('080/060')).toEqual({ sys: 80, dia: 60 });
  });
});
