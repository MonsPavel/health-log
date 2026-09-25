// TASK-006 §19: юнит-тесты Result — композиция, маппинг, unsafeUnwrap бросает в тестах.
import { describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';
import {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unsafeUnwrap,
  type Result,
} from './result.js';

describe('Result: конструкторы ok/err (§7)', () => {
  it('ok оборачивает значение в успешную ветку', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err оборачивает ошибку в неуспешную ветку', () => {
    const failure = AppError.of('APP/INTERNAL', 'kernel.error.internal');
    expect(err(failure)).toEqual({ ok: false, error: failure });
  });

  it('isOk/isErr различают ветки', () => {
    const success: Result<number> = ok(42);
    const failure: Result<number> = err(AppError.of('VALIDATION/FAILED', 'kernel.error.validation'));

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);
  });

  it('E по умолчанию — AppError: err(AppError…) присваивается к Result<T>', () => {
    const failure: Result<number> = err(AppError.of('APP/NOT_IMPLEMENTED', 'kernel.error.nyi'));
    expect(failure.ok).toBe(false);
  });
});

describe('Result: маппинг и композиция (§19)', () => {
  it('map применяет функцию к значению ok', () => {
    const result = map(ok(2), (n) => n * 10);
    expect(result).toEqual({ ok: true, value: 20 });
  });

  it('map не вызывает функцию на err и сохраняет ошибку', () => {
    const failure = AppError.of('VALIDATION/FAILED', 'kernel.error.validation');
    let called = false;
    const result = map<number, number, AppError>(err(failure), (n) => {
      called = true;
      return n;
    });

    expect(called).toBe(false);
    expect(result).toEqual({ ok: false, error: failure });
  });

  it('mapErr преобразует ошибку, не трогая ok', () => {
    const failure = AppError.of('APP/INTERNAL', 'kernel.error.internal');
    expect(mapErr(err(failure), (e) => e.messageKey)).toEqual({
      ok: false,
      error: 'kernel.error.internal',
    });
    expect(mapErr(ok(7), () => 'не вызывается')).toEqual({ ok: true, value: 7 });
  });

  it('andThen выстраивает композицию из ok в ok', () => {
    const parse = (s: string): Result<number, AppError> =>
      s === '7' ? ok(7) : err(AppError.of('VALIDATION/FAILED', 'kernel.error.validation'));
    const result = andThen(ok('7'), parse);

    expect(result).toEqual({ ok: true, value: 7 });
  });

  it('andThen пробрасывает ошибку первого шага без вызова следующего', () => {
    const failure = AppError.of('APP/INTERNAL', 'kernel.error.internal');
    let called = false;
    const result = andThen(
      err<number, AppError>(failure),
      (n: number) => {
        called = true;
        return ok(n);
      },
    );

    expect(called).toBe(false);
    expect(result).toEqual({ ok: false, error: failure });
  });
});

describe('Result: unsafeUnwrap — только для тестов (§5)', () => {
  it('возвращает значение на ok', () => {
    expect(unsafeUnwrap(ok('значение'))).toBe('значение');
  });

  it('бросает на err, ошибку кладёт в cause', () => {
    const failure = AppError.of('APP/NOT_IMPLEMENTED', 'kernel.error.nyi');
    let caught: unknown;
    try {
      unsafeUnwrap(err<number>(failure));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('unsafeUnwrap');
    expect((caught as Error).cause).toBe(failure);
  });
});
