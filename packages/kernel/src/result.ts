/**
 * TASK-006 §7: Result — значение или ошибка; исключения не пересекают границы слоёв
 * (арх. 02 §5). E по умолчанию — AppError. Мини-свой Result вместо neverthrow:
 * ~40 строк, нулевая зависимость, полный контроль сериализации (§4).
 * unsafeUnwrap — тестовая эвакуация (§5): бросает, в production-коде не используется.
 */
import type { AppError } from './app-error.js';

/** Успешная ветка Result. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Ошибочная ветка Result. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Результат операции: `{ ok: true; value } | { ok: false; error }` (§7). */
export type Result<T, E = AppError> = Ok<T> | Err<E>;

/** Оборачивает значение в успешную ветку. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Оборачивает ошибку в неуспешную ветку. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** true, если Result успешен; сужает тип к Ok<T>. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** true, если Result неуспешен; сужает тип к Err<E>. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Маппинг значения ok; err проходит насквозь, функция не вызывается. */
export function map<T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return isOk(result) ? ok(f(result.value)) : result;
}

/** Маппинг ошибки err; ok проходит насквозь, функция не вызывается. */
export function mapErr<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return isErr(result) ? err(f(result.error)) : result;
}

/** Композиция: ok передаёт значение в следующий шаг, err — короткое замыкание. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> {
  return isOk(result) ? f(result.value) : result;
}

/** Только для тестов (§5): извлекает значение ok, на err бросает с ошибкой в cause. */
export function unsafeUnwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.value;
  }
  throw new Error('unsafeUnwrap: Result в состоянии err — раскрывать err можно только в тестах', {
    cause: result.error,
  });
}
