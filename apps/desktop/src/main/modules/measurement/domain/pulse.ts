/**
 * TASK-016 §7: VO пульса — брендированное целое число ударов/мин (PulseBpm): сырое
 * число нельзя подставить в поле пульса минуя валидацию. undefined = «не измерен» —
 * валидное значение (SRS FR-1.1: ЧСС опциональна). Границы — BP_LIMITS.PULSE_*.
 */
import { AppError, err, ok, type Result } from '@hl/kernel';

import { BP_LIMITS, INVALID_RANGE_MESSAGE_KEY } from './constants.js';

/** Бренд-тип пульса: число bpm, прошедшее валидацию Pulse.create (§7). */
export type PulseBpm = number & { readonly __brand: 'PulseBpm' };

/** Пульс измерения — валидное bpm; «не измерен» выражается отсутствием значения. */
export type Pulse = PulseBpm;

/** Фабрика пульса: undefined пропускает как «не измерен», число проверяет по границам. */
export const Pulse = {
  create(value: number | undefined): Result<Pulse | undefined, AppError> {
    if (value === undefined) {
      return ok(undefined);
    }
    if (!Number.isInteger(value) || value < BP_LIMITS.PULSE_MIN || value > BP_LIMITS.PULSE_MAX) {
      return err(
        AppError.of('MEASUREMENT/INVALID_RANGE', INVALID_RANGE_MESSAGE_KEY, {
          field: 'pulse',
          value,
          min: BP_LIMITS.PULSE_MIN,
          max: BP_LIMITS.PULSE_MAX,
        }),
      );
    }
    return ok(value as PulseBpm);
  },
};
