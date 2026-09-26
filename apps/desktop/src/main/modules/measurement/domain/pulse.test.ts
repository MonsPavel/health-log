// TASK-016 §19: пульс — опционален (undefined = «не измерен» — валидно), границы 20–300
// включительны; дробные значения отклоняются (§13: дробь = опечатка). Моки не нужны.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isErr, isOk } from '@hl/kernel';

import { BP_LIMITS } from './constants.js';
import { Pulse } from './pulse.js';

describe('Pulse.create — валидные значения (§7)', () => {
  it('undefined = «не измерен» → ok(undefined) (§7)', () => {
    const result = Pulse.create(undefined);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBeUndefined();
    }
  });

  it('80 → ok(80) — брендированное число PulseBpm', () => {
    const result = Pulse.create(80);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(80);
    }
  });

  it('нижняя граница включительна: 20 → ok (§13)', () => {
    expect(isOk(Pulse.create(BP_LIMITS.PULSE_MIN))).toBe(true);
  });

  it('верхняя граница включительна: 300 → ok (§20)', () => {
    expect(isOk(Pulse.create(BP_LIMITS.PULSE_MAX))).toBe(true);
  });
});

describe('Pulse.create — INVALID_RANGE (§7: params {field, value, min, max})', () => {
  it.each([0, 19, 301])('%i вне диапазона → err INVALID_RANGE (§20)', (value) => {
    const result = Pulse.create(value);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
      expect(result.error.params).toEqual({
        field: 'pulse',
        value,
        min: BP_LIMITS.PULSE_MIN,
        max: BP_LIMITS.PULSE_MAX,
      });
    }
  });

  it.each([80.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '%j — не целое → err INVALID_RANGE (§13)',
    (value) => {
      const result = Pulse.create(value);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
        expect(result.error.params?.['field']).toBe('pulse');
      }
    },
  );

  it('messageKey по конвенции арх. 05 §29: errors.MEASUREMENT_INVALID_RANGE', () => {
    const result = Pulse.create(0);

    expect(isErr(result) && result.error.messageKey).toBe('errors.MEASUREMENT_INVALID_RANGE');
  });
});

describe('Property-тесты Pulse (fast-check, §19)', () => {
  it('значения из [20, 300] целыми проходят, вне диапазона или дробные — INVALID_RANGE', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 4000 }), (value) => {
        const result = Pulse.create(value);
        const valid = value >= BP_LIMITS.PULSE_MIN && value <= BP_LIMITS.PULSE_MAX;

        if (valid) {
          expect(isOk(result)).toBe(true);
        } else {
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
            expect(result.error.params).toEqual({
              field: 'pulse',
              value,
              min: BP_LIMITS.PULSE_MIN,
              max: BP_LIMITS.PULSE_MAX,
            });
          }
        }
      }),
    );
  });
});
