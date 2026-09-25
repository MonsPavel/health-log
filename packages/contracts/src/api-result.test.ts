// TASK-008 §19: schema-тесты конверта ApiResult/ApiEnvelope — форма ответа всех каналов
// (арх. 05 §2): ошибка приходит как данные {ok:false,error}, никогда как исключение.
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  API_ENVELOPE_VERSION,
  apiFailure,
  apiSuccess,
  isApiEnvelope,
  type ApiEnvelope,
} from './api-result.js';
import { APP_INTERNAL_ERROR } from './app-error-dto.js';

describe('ApiEnvelope — константа версии (арх. 05 §6)', () => {
  it('версия конверта v=1', () => {
    expect(API_ENVELOPE_VERSION).toBe(1);
  });
});

describe('apiSuccess / apiFailure — конструкторы конверта', () => {
  it('apiSuccess заворачивает данные в {v:1, ok:true, data}', () => {
    expect(apiSuccess({ pong: true })).toEqual({ v: 1, ok: true, data: { pong: true } });
  });

  it('apiFailure заворачивает AppErrorDto в {v:1, ok:false, error}', () => {
    const envelope = apiFailure(APP_INTERNAL_ERROR);

    expect(envelope).toEqual({ v: 1, ok: false, error: APP_INTERNAL_ERROR });
    // Данные в ошибочной ветке отсутствуют — форма конверта строго из арх. 05 §2.
    expect('data' in envelope).toBe(false);
  });
});

describe('isApiEnvelope — type guard формы ответа (недоверенная граница)', () => {
  it('принимает конверты обеих веток', () => {
    expect(isApiEnvelope({ v: 1, ok: true, data: {} })).toBe(true);
    expect(isApiEnvelope({ v: 1, ok: false, error: { code: 'APP/INTERNAL', messageKey: 'e' } })).toBe(
      true,
    );
  });

  it('отклоняет не-объекты и мусор', () => {
    expect(isApiEnvelope(null)).toBe(false);
    expect(isApiEnvelope(undefined)).toBe(false);
    expect(isApiEnvelope('конверт')).toBe(false);
    expect(isApiEnvelope(42)).toBe(false);
  });

  it('отклоняет конверты без v, с чужой версией или без ветки ok', () => {
    expect(isApiEnvelope({ ok: true, data: {} })).toBe(false); // нет v
    expect(isApiEnvelope({ v: 2, ok: true, data: {} })).toBe(false); // чужая версия
    expect(isApiEnvelope({ v: '1', ok: true, data: {} })).toBe(false); // v не число-литерал
    expect(isApiEnvelope({ v: 1 })).toBe(false); // нет ветки ok
  });
});

describe('ApiEnvelope — типизация', () => {
  it('ApiEnvelope<T> сужается до ApiResult<T> по ветке ok', () => {
    const envelope: ApiEnvelope<number> = apiSuccess(5);

    if (envelope.ok) {
      expectTypeOf(envelope.data).toEqualTypeOf<number>();
    } else {
      expectTypeOf(envelope.error.code).toEqualTypeOf<'APP/INTERNAL' | 'APP/NOT_IMPLEMENTED' | 'VALIDATION/FAILED'>();
    }
  });
});
