// TASK-016 §19: юниты на границах (диапазоны включительные с обеих сторон), sys==dia/sys<dia,
// дробные значения; property fast-check: для любых sys>dia из диапазона create успешен,
// иначе — ошибка с корректными params. Моки не нужны — чистый домен.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isErr, isOk, type Result } from '@hl/kernel';

import { BloodPressure } from './blood-pressure.js';
import { BP_LIMITS } from './constants.js';

describe('BloodPressure.create — валидные значения (§7, §13)', () => {
  it('120/80 → ok с полями sys/dia', () => {
    const result = BloodPressure.create(120, 80);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.sys).toBe(120);
      expect(result.value.dia).toBe(80);
    }
  });

  it('нижние границы включительны: 50/20 → ok (§13)', () => {
    const result = BloodPressure.create(BP_LIMITS.SYS_MIN, BP_LIMITS.DIA_MIN);

    expect(isOk(result)).toBe(true);
  });

  it('верхние границы включительны: 300/200 → ok (§13)', () => {
    const result = BloodPressure.create(BP_LIMITS.SYS_MAX, BP_LIMITS.DIA_MAX);

    expect(isOk(result)).toBe(true);
  });

  it('равенство по полям: одинаковые sys/dia — равны, разные — не равны (§7)', () => {
    const a = BloodPressure.create(120, 80);
    const b = BloodPressure.create(120, 80);
    const c = BloodPressure.create(130, 80);

    expect(isOk(a) && isOk(b) && isOk(c)).toBe(true);
    if (isOk(a) && isOk(b) && isOk(c)) {
      expect(a.value.equals(b.value)).toBe(true);
      expect(a.value.equals(c.value)).toBe(false);
    }
  });
});

describe('BloodPressure.create — INVALID_RANGE (§7: params {field, value, min, max})', () => {
  it.each([
    [49, 80, 'sys'],
    [301, 80, 'sys'],
    [120, 19, 'dia'],
    [120, 201, 'dia'],
  ] as const)('sys=%i, dia=%i → err INVALID_RANGE по полю %s', (sys, dia, field) => {
    const result = BloodPressure.create(sys, dia);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
      expect(result.error.params).toEqual({
        field,
        value: field === 'sys' ? sys : dia,
        min: field === 'sys' ? BP_LIMITS.SYS_MIN : BP_LIMITS.DIA_MIN,
        max: field === 'sys' ? BP_LIMITS.SYS_MAX : BP_LIMITS.DIA_MAX,
      });
    }
  });

  it('49.5/80 → err INVALID_RANGE: дробь = не целое (§20)', () => {
    const result = BloodPressure.create(49.5, 80);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
      expect(result.error.params).toEqual({
        field: 'sys',
        value: 49.5,
        min: BP_LIMITS.SYS_MIN,
        max: BP_LIMITS.SYS_MAX,
      });
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('нечисло %j → err INVALID_RANGE', (sys) => {
    const result = BloodPressure.create(sys, 80);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
    }
  });

  it('messageKey по конвенции арх. 05 §29: errors.MEASUREMENT_INVALID_RANGE', () => {
    const result: Result<BloodPressure, unknown> = BloodPressure.create(49, 80);

    expect(isErr(result) && result.error.messageKey).toBe('errors.MEASUREMENT_INVALID_RANGE');
  });
});

describe('BloodPressure.create — SYS_LE_DIA (§13: строгое «>»)', () => {
  it('80/120 → err SYS_LE_DIA с params {sys, dia} (§20)', () => {
    const result = BloodPressure.create(80, 120);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/SYS_LE_DIA');
      expect(result.error.params).toEqual({ sys: 80, dia: 120 });
    }
  });

  it('120/120 → err SYS_LE_DIA: равенство недопустимо (§20)', () => {
    const result = BloodPressure.create(120, 120);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/SYS_LE_DIA');
      expect(result.error.params).toEqual({ sys: 120, dia: 120 });
    }
  });

  it('messageKey по конвенции арх. 05 §29: errors.MEASUREMENT_SYS_LE_DIA', () => {
    const result = BloodPressure.create(120, 120);

    expect(isErr(result) && result.error.messageKey).toBe('errors.MEASUREMENT_SYS_LE_DIA');
  });
});

describe('BloodPressure.create — порядок валидации (§7)', () => {
  it('(1) целые раньше порядка: 49.5/80 → INVALID_RANGE, не SYS_LE_DIA', () => {
    const result = BloodPressure.create(49.5, 80);

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
  });

  it('(2) диапазон sys проверяется раньше dia: 301/400 → params.field = "sys"', () => {
    const result = BloodPressure.create(301, 400);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.params?.['field']).toBe('sys');
    }
  });
});

describe('Property-тесты BloodPressure (fast-check, §19)', () => {
  it('create успешен ⇔ sys > dia; err несёт код SYS_LE_DIA и params {sys, dia}', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: BP_LIMITS.SYS_MIN, max: BP_LIMITS.SYS_MAX }),
        fc.integer({ min: BP_LIMITS.DIA_MIN, max: BP_LIMITS.DIA_MAX }),
        (sys, dia) => {
          const result = BloodPressure.create(sys, dia);

          if (sys > dia) {
            expect(isOk(result)).toBe(true);
            if (isOk(result)) {
              expect(result.value.sys).toBe(sys);
              expect(result.value.dia).toBe(dia);
            }
          } else {
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.error.code).toBe('MEASUREMENT/SYS_LE_DIA');
              expect(result.error.params).toEqual({ sys, dia });
            }
          }
        },
      ),
    );
  });
});
