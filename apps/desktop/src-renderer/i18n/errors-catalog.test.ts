/**
 * TASK-113 (репетиция новичка): каталог errors.* обязан содержать ключи, которые
 * main присылает динамически (messageKey констант домена — §17/§6.2: errors вне
 * unused-проверки check:i18n, потому что потребляются по messageKey из IPC).
 * Поймано e2e-репетицией: отказ домена MEASUREMENT/FUTURE_TIME рендерил общий
 * fallback «Что-то пошло не так» вместо понятного текста (ключ отсутствовал).
 */
import { describe, expect, it } from 'vitest';

import errors from './ru/errors.json';

describe('каталог errors.* — динамические messageKey домена (TASK-113)', () => {
  it('MEASUREMENT_FUTURE_TIME существует и непуст (тост отказа FUTURE_TIME из main)', () => {
    const message: unknown = errors['MEASUREMENT_FUTURE_TIME'];
    expect(typeof message).toBe('string');
    expect((message as string).length).toBeGreaterThan(5);
  });

  it('MEASUREMENT_NOT_FOUND существует (прецедент конвенции — ключ домена в каталоге)', () => {
    expect(typeof errors['MEASUREMENT_NOT_FOUND']).toBe('string');
  });
});
