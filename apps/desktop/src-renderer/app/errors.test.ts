/**
 * TASK-011 §19: тесты хелперов клиентских ошибок — toUserMessage (каталог + fallback
 * errors.internal, §20 п. 4), computeDigest (хеш message+первой строки стека, §7),
 * logClientError (канал app/log-client-error, mock window.hl, §9/§11).
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { computeDigest, logClientError, RENDERER_ERROR_CODE, toUserMessage } from './errors';

/** Fake моста window.hl (§19, прецедент events.test.ts). */
function installFakeBridge(): { invoke: Mock } {
  const invoke = vi.fn(() => Promise.resolve({ v: 1, ok: true, data: null }));
  Object.defineProperty(window, 'hl', { configurable: true, value: { invoke }, writable: true });
  return { invoke };
}

function removeBridge(): void {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
}

afterEach(() => {
  removeBridge();
  vi.restoreAllMocks();
});

describe('toUserMessage — каталог + fallback (§17, §20 п. 4)', () => {
  it('известный ключ errors.internal — текст каталога', () => {
    const message = toUserMessage({ code: 'APP/INTERNAL', messageKey: 'errors.internal' });
    expect(message).toBe('Что-то пошло не так. Попробуйте ещё раз.');
  });

  it('известный ключ errors.validation — текст каталога', () => {
    const message = toUserMessage({ code: 'VALIDATION/FAILED', messageKey: 'errors.validation' });
    expect(message).toBe('Проверьте правильность заполнения полей и попробуйте ещё раз.');
  });

  it('невалидный messageKey — fallback errors.internal, не «undefined» (§20 п. 4)', () => {
    const unknown = toUserMessage({ code: 'APP/INTERNAL', messageKey: 'errors.nope' });
    expect(unknown).toBe('Что-то пошло не так. Попробуйте ещё раз.');

    const notInCatalog = toUserMessage({ code: 'APP/INTERNAL', messageKey: 'случайная строка' });
    expect(notInCatalog).toBe('Что-то пошло не так. Попробуйте ещё раз.');
  });
});

describe('computeDigest — дедупликация в логах (§7/§18)', () => {
  it('детерминирован: одна и та же ошибка — один digest', () => {
    const error = (): Error =>
      Object.assign(new Error('boom'), { stack: 'Error: boom\n    at f (a.js:1:1)' });
    expect(computeDigest(error())).toBe(computeDigest(error()));
  });

  it('разные сообщения — разные digest', () => {
    const withStack = (message: string): Error =>
      Object.assign(new Error(message), { stack: `${message}\n    at f (a.js:1:1)` });
    expect(computeDigest(withStack('a'))).not.toBe(computeDigest(withStack('b')));
  });

  it('формат: hex ≤64 символов (§11/§14)', () => {
    const digest = computeDigest(new Error('x'));
    expect(digest).toMatch(/^[0-9a-f]+$/);
    expect(digest.length).toBeLessThanOrEqual(64);
  });

  it('не-Error вход (строка) не бросает', () => {
    expect(computeDigest('строка')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('logClientError — канал app/log-client-error (§9/§11)', () => {
  it('отправляет {code: APP/RENDERER, messageKey, digest} через мост', () => {
    const { invoke } = installFakeBridge();

    logClientError({
      code: RENDERER_ERROR_CODE,
      messageKey: 'errors.renderer',
      digest: '1a2b3c4d',
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('app/log-client-error', {
      code: 'APP/RENDERER',
      messageKey: 'errors.renderer',
      digest: '1a2b3c4d',
    });
  });

  it('RENDERER_ERROR_CODE — литерал контракта (§7)', () => {
    expect(RENDERER_ERROR_CODE).toBe('APP/RENDERER');
  });

  it('ошибка конверта/транспорта глушится — логгер не ломает UI (§9)', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('битый конверт')));
    Object.defineProperty(window, 'hl', { configurable: true, value: { invoke }, writable: true });

    expect(() =>
      logClientError({ code: RENDERER_ERROR_CODE, messageKey: 'errors.renderer', digest: 'd' }),
    ).not.toThrow();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('мост недоступен (window.hl undefined) — не бросает', () => {
    removeBridge();
    expect(() =>
      logClientError({ code: RENDERER_ERROR_CODE, messageKey: 'errors.renderer', digest: 'd' }),
    ).not.toThrow();
  });
});
