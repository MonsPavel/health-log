/**
 * Публичный API @hl/kernel (TASK-006 §5/§20). Kernel — единственный пакет, зависящий
 * «ни от чего» (арх. 03 §4); растёт только через осознанную задачу (§22 TASK-006).
 */
export { AppError, type AppErrorParams } from './app-error.js';
export { AI_MIN_DAYS, AI_MIN_MEASUREMENTS } from './constants.js';
export { ERROR_CODES, type ErrorCode } from './error-codes.js';
export { FixedClock, SystemClock, type Clock } from './clock.js';
// Instant — имя с двумя значениями (структурный тип + операции §7): экспорт и тип, и значение.
export { Instant, type WallTime } from './instant.js';
export {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unsafeUnwrap,
  type Err,
  type Ok,
  type Result,
} from './result.js';
