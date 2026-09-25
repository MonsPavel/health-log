// TASK-008 §7/§19: сериализация AppError → AppErrorDto. Правило арх. 05 §2: наружу —
// только code/messageKey/params/retryable; стеки и cause никогда не покидают main (§14).
import { describe, expect, it } from 'vitest';

import { AppError, ERROR_CODES } from '@hl/kernel';

import {
  APP_INTERNAL_ERROR,
  VALIDATION_FAILED_ERROR,
  toDto,
  type AppErrorDto,
} from './app-error-dto.js';

describe('toDto — маппинг AppError в DTO (§7)', () => {
  it('переносит code и messageKey как есть', () => {
    const error = AppError.of('VALIDATION/FAILED', 'kernel.error.validation');
    const dto = toDto(error);

    expect(dto.code).toBe('VALIDATION/FAILED');
    expect(dto.messageKey).toBe('kernel.error.validation');
  });

  it('переносит params без изменений', () => {
    const params = { min: 7, max: 3 };
    const dto = toDto(AppError.of('VALIDATION/FAILED', 'kernel.error.validation', params));

    expect(dto.params).toBe(params);
  });

  it('без params поле отсутствует (не null и не {})', () => {
    const dto: AppErrorDto = toDto(AppError.of('APP/INTERNAL', 'errors.internal'));

    expect('params' in dto).toBe(false);
  });

  it('cause остаётся в памяти main: в DTO нет ни cause, ни стека (арх. 05 §2, §14)', () => {
    const cause = new Error('внутренняя причина — только для main-лога');
    const dto = toDto(AppError.of('APP/INTERNAL', 'errors.internal', undefined, cause));
    const serialized: unknown = JSON.parse(JSON.stringify(dto));

    expect('cause' in dto).toBe(false);
    expect('stack' in dto).toBe(false);
    expect(serialized).toEqual({ code: 'APP/INTERNAL', messageKey: 'errors.internal' });
  });

  it('retryable не выставляется: реестр повторяемых кодов пока пуст (§13, NET/* — TASK-075/080)', () => {
    for (const code of ERROR_CODES) {
      const dto = toDto(AppError.of(code, 'errors.any'));

      expect('retryable' in dto, `код ${code}`).toBe(false);
    }
  });
});

describe('синтезируемые каркасом ошибки (§13)', () => {
  it('APP_INTERNAL_ERROR: код APP/INTERNAL, messageKey по конвенции §17', () => {
    expect(APP_INTERNAL_ERROR).toEqual({ code: 'APP/INTERNAL', messageKey: 'errors.internal' });
  });

  it('VALIDATION_FAILED_ERROR: код VALIDATION/FAILED, messageKey по конвенции §17', () => {
    expect(VALIDATION_FAILED_ERROR).toEqual({
      code: 'VALIDATION/FAILED',
      messageKey: 'errors.validation',
    });
  });
});
