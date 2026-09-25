// TASK-008 §19: schema-тесты реестра каналов — zod на границе доверия (арх. 08 §4):
// недоверенный payload рендерера отклоняется до вызова use case, strict-объекты против
// prototype-pollution (§14).
import { describe, expect, it } from 'vitest';

import { CHANNEL_SCHEMAS } from './schemas.js';

const PING = CHANNEL_SCHEMAS['app/ping'];

describe('CHANNEL_SCHEMAS["app/ping"] — request (§11: {})', () => {
  it('принимает пустой объект', () => {
    expect(PING.request.safeParse({}).success).toBe(true);
  });

  it('strict: отклоняет неизвестные поля (prototype-pollution, §14)', () => {
    expect(PING.request.safeParse({ extra: 1 }).success).toBe(false);
    // own-свойство __proto__ (как из JSON недоверенного рендерера), не установка прототипа.
    const pollution: object = JSON.parse('{"__proto__": {"isAdmin": true}}') as object;
    expect(PING.request.safeParse(pollution).success).toBe(false);
  });

  it('отклоняет не-объекты', () => {
    expect(PING.request.safeParse('ping').success).toBe(false);
    expect(PING.request.safeParse(null).success).toBe(false);
    expect(PING.request.safeParse(undefined).success).toBe(false);
    expect(PING.request.safeParse([]).success).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS["app/ping"] — response (§11: {pong: true, ts: number})', () => {
  it('принимает {pong: true, ts: число}', () => {
    const parsed = PING.response.safeParse({ pong: true, ts: 1_700_000_000_000 });

    expect(parsed.success).toBe(true);
  });

  it('отклоняет pong: false и pong, отличное от literal true', () => {
    expect(PING.response.safeParse({ pong: false, ts: 1 }).success).toBe(false);
    expect(PING.response.safeParse({ pong: 1, ts: 1 }).success).toBe(false);
  });

  it('отклоняет ответ без ts', () => {
    expect(PING.response.safeParse({ pong: true }).success).toBe(false);
  });

  it('strict: отклоняет неизвестные поля', () => {
    expect(PING.response.safeParse({ pong: true, ts: 1, extra: 'x' }).success).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS["app/log-client-error"] — клиентский отчёт об ошибке (TASK-011 §11)', () => {
  const LOG_CLIENT_ERROR = CHANNEL_SCHEMAS['app/log-client-error'];

  const validRequest = {
    code: 'APP/RENDERER',
    messageKey: 'errors.renderer',
    digest: '1a2b3c4d',
  };

  it('принимает валидный отчёт {code, messageKey, digest}', () => {
    expect(LOG_CLIENT_ERROR.request.safeParse(validRequest).success).toBe(true);
  });

  it('принимает границу длин: messageKey 200, digest 64 (§14)', () => {
    expect(
      LOG_CLIENT_ERROR.request.safeParse({
        ...validRequest,
        messageKey: 'k'.repeat(200),
        digest: 'd'.repeat(64),
      }).success,
    ).toBe(true);
  });

  it('отклоняет messageKey длиннее 200 и digest длиннее 64 (§14: недоверенный рендерер)', () => {
    expect(
      LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, messageKey: 'k'.repeat(201) }).success,
    ).toBe(false);
    expect(
      LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, digest: 'd'.repeat(65) }).success,
    ).toBe(false);
  });

  it('code — только литерал APP/RENDERER (§7: чужие коды в клиентский канал не проходят)', () => {
    expect(LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, code: 'APP/INTERNAL' }).success).toBe(
      false,
    );
    expect(LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, code: 'VALIDATION/FAILED' }).success).toBe(
      false,
    );
  });

  it('strict: отклоняет неизвестные поля и неполные отчёты (§14)', () => {
    expect(LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, stack: 'x' }).success).toBe(false);
    expect(LOG_CLIENT_ERROR.request.safeParse({ code: 'APP/RENDERER' }).success).toBe(false);
    expect(LOG_CLIENT_ERROR.request.safeParse(null).success).toBe(false);
  });

  it('response — null (fire-and-forget, §9/§11)', () => {
    expect(LOG_CLIENT_ERROR.response.safeParse(null).success).toBe(true);
    expect(LOG_CLIENT_ERROR.response.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS — дисциплина реестра (§5)', () => {
  it('реестр типизирован по ChannelName: app/ping и app/log-client-error (TASK-011)', () => {
    expect(Object.keys(CHANNEL_SCHEMAS)).toEqual(['app/ping', 'app/log-client-error']);
  });

  it('каждый канал несёт пару схем request/response', () => {
    for (const schemas of Object.values(CHANNEL_SCHEMAS)) {
      expect(typeof schemas.request.parse).toBe('function');
      expect(typeof schemas.response.parse).toBe('function');
    }
  });
});
