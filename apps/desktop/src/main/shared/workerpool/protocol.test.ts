/**
 * TASK-066 §6/§19: unit-тесты протокола пула — wire-типы, guard входящих сообщений
 * воркера, валидация прогресса (§7: progress 0..1), TaskError (форма отказа job на
 * main-стороне). Чистые функции без worker_threads — быстрые юниты; сами потоки
 * (реальные worker_threads) — pool.int.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { TaskError, isValidProgress, isWorkerToMainMessage, toTaskError } from './protocol.js';

describe('isWorkerToMainMessage — guard сообщений worker → main (§7)', () => {
  it('принимает результат ok:true', () => {
    expect(
      isWorkerToMainMessage({ kind: 'result', jobId: 1, ok: true, value: { any: 'thing' } }),
    ).toBe(true);
  });

  it('принимает результат ok:false с сериализованной ошибкой', () => {
    expect(
      isWorkerToMainMessage({
        kind: 'result',
        jobId: 2,
        ok: false,
        error: { name: 'Error', message: 'boom' },
      }),
    ).toBe(true);
  });

  it('принимает прогресс', () => {
    expect(isWorkerToMainMessage({ kind: 'progress', jobId: 3, progress: 0.5 })).toBe(true);
  });

  it('отклоняет мусор: не-объект, без kind, неизвестный kind, битые поля', () => {
    expect(isWorkerToMainMessage(null)).toBe(false);
    expect(isWorkerToMainMessage('result')).toBe(false);
    expect(isWorkerToMainMessage({})).toBe(false);
    expect(isWorkerToMainMessage({ kind: 'other', jobId: 1 })).toBe(false);
    // result без ok / с нечисловым jobId
    expect(isWorkerToMainMessage({ kind: 'result', jobId: '1', ok: true, value: 1 })).toBe(false);
    expect(isWorkerToMainMessage({ kind: 'result', jobId: 1, value: 1 })).toBe(false);
    // result ok:false без ошибки
    expect(isWorkerToMainMessage({ kind: 'result', jobId: 1, ok: false })).toBe(false);
    // progress без числа
    expect(isWorkerToMainMessage({ kind: 'progress', jobId: 1, progress: '0.5' })).toBe(false);
    // run без name (не форма worker → main)
    expect(isWorkerToMainMessage({ kind: 'run', jobId: 1, payload: {} })).toBe(false);
  });
});

describe('isValidProgress — прогресс обязан быть числом 0..1 (§7)', () => {
  it('граничные и промежуточные значения валидны', () => {
    expect(isValidProgress(0)).toBe(true);
    expect(isValidProgress(0.5)).toBe(true);
    expect(isValidProgress(1)).toBe(true);
  });

  it('вне диапазона, NaN, Infinity — невалидны', () => {
    expect(isValidProgress(-0.1)).toBe(false);
    expect(isValidProgress(1.1)).toBe(false);
    expect(isValidProgress(Number.NaN)).toBe(false);
    expect(isValidProgress(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('TaskError — форма отказа job на main-стороне (§13 fail-fast)', () => {
  it('это Error с именем TaskError', () => {
    const error = new TaskError('worker crashed');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TaskError');
    expect(error.message).toBe('worker crashed');
  });

  it('toTaskError переносит сообщение и cause сериализованной ошибки', () => {
    const serialized = { name: 'Error', message: 'task failed', cause: { code: 'X' } };
    const error = toTaskError(serialized);
    expect(error).toBeInstanceOf(TaskError);
    expect(error.message).toBe('task failed');
    expect(error.cause).toEqual({ code: 'X' });
  });

  it('toTaskError без cause — cause не определён', () => {
    const error = toTaskError({ name: 'RangeError', message: 'index' });
    expect(error.message).toBe('index');
    expect(error.cause).toBeUndefined();
  });
});
