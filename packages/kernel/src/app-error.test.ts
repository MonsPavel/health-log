// TASK-006 §19: юнит-тесты фабрики AppError; §14 — в полях сериализации нет стека.
import { describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';

describe('AppError.of — фабрика (§7)', () => {
  it('создаёт ошибку с code и messageKey (ключ i18n, не текст)', () => {
    const error = AppError.of('VALIDATION/FAILED', 'kernel.error.validation');

    expect(error.code).toBe('VALIDATION/FAILED');
    expect(error.messageKey).toBe('kernel.error.validation');
  });

  it('сохраняет params', () => {
    const params = { min: 7, days: 3 };
    const error = AppError.of('VALIDATION/FAILED', 'kernel.error.validation', params);

    expect(error.params).toBe(params);
  });

  it('сохраняет cause (только в памяти main, §14)', () => {
    const cause = new Error('внутренняя причина для логов');
    const error = AppError.of('APP/INTERNAL', 'kernel.error.internal', undefined, cause);

    expect(error.cause).toBe(cause);
  });

  it('без params и cause соответствующие поля не заданы', () => {
    const error = AppError.of('APP/NOT_IMPLEMENTED', 'kernel.error.nyi');

    expect(error.params).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});

describe('AppError — дисциплина сериализации (§11, §14)', () => {
  it('не содержит стек: поля stack нет у экземпляра', () => {
    const error = AppError.of('APP/INTERNAL', 'kernel.error.internal');

    expect('stack' in error).toBe(false);
  });

  it('JSON-сериализация сохраняет code/messageKey/params без потери (задел TASK-008)', () => {
    const error = AppError.of('VALIDATION/FAILED', 'kernel.error.validation', { min: 7 });
    const restored: unknown = JSON.parse(JSON.stringify(error));

    expect(restored).toEqual({
      code: 'VALIDATION/FAILED',
      messageKey: 'kernel.error.validation',
      params: { min: 7 },
    });
  });
});
