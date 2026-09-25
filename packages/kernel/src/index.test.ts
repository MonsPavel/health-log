// TASK-006 §20: все контракты §5/§7 экспортированы из точки входа @hl/kernel.
import { describe, expect, it } from 'vitest';

import * as kernel from './index.js';

describe('Публичный API @hl/kernel (§20)', () => {
  it('экспортирует ровно значения контрактов kernel', () => {
    expect(Object.keys(kernel).sort()).toEqual(
      [
        'AI_MIN_DAYS',
        'AI_MIN_MEASUREMENTS',
        'AppError',
        'ERROR_CODES',
        'FixedClock',
        'Instant',
        'SystemClock',
        'andThen',
        'err',
        'isErr',
        'isOk',
        'map',
        'mapErr',
        'ok',
        'unsafeUnwrap',
      ].sort(),
    );
  });

  it('Instant предоставляет операции §7: wallTime/toIso/fromIso/compare', () => {
    expect(typeof kernel.Instant.wallTime).toBe('function');
    expect(typeof kernel.Instant.toIso).toBe('function');
    expect(typeof kernel.Instant.fromIso).toBe('function');
    expect(typeof kernel.Instant.compare).toBe('function');
  });

  it('AppError создаётся через фабрику of', () => {
    // Конструктор приватен типово (единственный путь создания — AppError.of, §7);
    // рантайм-гарантию даёт app-error.test.ts через поведение фабрики.
    expect(typeof kernel.AppError.of).toBe('function');
    const error = kernel.AppError.of('APP/INTERNAL', 'kernel.error.internal');
    expect(error.code).toBe('APP/INTERNAL');
  });

  it('SystemClock и FixedClock — конструкторы', () => {
    expect(typeof kernel.SystemClock).toBe('function');
    expect(typeof kernel.FixedClock).toBe('function');
  });
});
