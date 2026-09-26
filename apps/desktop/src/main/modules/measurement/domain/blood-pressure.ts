/**
 * TASK-016 §7: VO артериального давления — иммутабельная пара {sys, dia} с инвариантом
 * «строго sys > dia» (арх. 02 §3.1). Единственный путь создания — фабрика create:
 * невалидное сочетание чисел не представимо типом (make invalid states unrepresentable,
 * §4). Ошибки возвращаются как Result с AppError — исключения не пересекают слои.
 * Порядок валидации §7: (1) целые → (2) диапазоны → (3) sys > dia.
 */
import { AppError, err, ok, type Result } from '@hl/kernel';

import { BP_LIMITS, INVALID_RANGE_MESSAGE_KEY, SYS_LE_DIA_MESSAGE_KEY } from './constants.js';

/** Поле давления, отвергнутое валидацией диапазона (подстановка для текста формы, §16–17). */
export type BpField = 'sys' | 'dia';

/** INVALID_RANGE с params {field, value, min, max} — подстановки текстов TASK-031. */
function rangeError(field: BpField, value: number, min: number, max: number): AppError {
  return AppError.of('MEASUREMENT/INVALID_RANGE', INVALID_RANGE_MESSAGE_KEY, {
    field,
    value,
    min,
    max,
  });
}

/** VO давления: целые мм рт. ст., sys ∈ [50, 300], dia ∈ [20, 200], строго sys > dia. */
export class BloodPressure {
  /** Приватный конструктор: создать VO можно только через валидирующую фабрику create. */
  private constructor(
    readonly sys: number,
    readonly dia: number,
  ) {}

  /** Валидирует и создаёт давление; любая причина отказа — Err с кодом MEASUREMENT/★. */
  static create(sys: number, dia: number): Result<BloodPressure, AppError> {
    if (!Number.isInteger(sys)) {
      return err(rangeError('sys', sys, BP_LIMITS.SYS_MIN, BP_LIMITS.SYS_MAX));
    }
    if (!Number.isInteger(dia)) {
      return err(rangeError('dia', dia, BP_LIMITS.DIA_MIN, BP_LIMITS.DIA_MAX));
    }
    if (sys < BP_LIMITS.SYS_MIN || sys > BP_LIMITS.SYS_MAX) {
      return err(rangeError('sys', sys, BP_LIMITS.SYS_MIN, BP_LIMITS.SYS_MAX));
    }
    if (dia < BP_LIMITS.DIA_MIN || dia > BP_LIMITS.DIA_MAX) {
      return err(rangeError('dia', dia, BP_LIMITS.DIA_MIN, BP_LIMITS.DIA_MAX));
    }
    if (sys <= dia) {
      return err(AppError.of('MEASUREMENT/SYS_LE_DIA', SYS_LE_DIA_MESSAGE_KEY, { sys, dia }));
    }
    return ok(new BloodPressure(sys, dia));
  }

  /** Равенство по полям (VO без идентичности, §7). */
  equals(other: BloodPressure): boolean {
    return this.sys === other.sys && this.dia === other.dia;
  }
}
