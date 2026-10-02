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
    expect(
      LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, code: 'APP/INTERNAL' }).success,
    ).toBe(false);
    expect(
      LOG_CLIENT_ERROR.request.safeParse({ ...validRequest, code: 'VALIDATION/FAILED' }).success,
    ).toBe(false);
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
  it('реестр типизирован по ChannelName: __bench/seed (TASK-062, test-only) + __test/insert-batch и __test/db-state (TASK-102, test-only крэш-тест) + ai/models/* (TASK-081) + ai/context/preview (TASK-083) + ai/summary/generate|latest|delete-all (TASK-087/088) + ai/chat/send|clear|list (TASK-089) + каркасные + app/reveal-path (TASK-068) + app/heartbeat (TASK-095) + app/selfcheck|meta|integrity-full (TASK-100) + app/reveal-backups и data/discard-db (TASK-101) + backup/create (TASK-070) + backup/restore (TASK-071) + data/wipe (TASK-072) + file/open-dialog (TASK-073) + 4 канала измерений (TASK-028) + notes/search (TASK-045) + prefs/get|set (TASK-047) + privacy/journal|consents (TASK-098) + report/export-csv|json (TASK-065) + report/pdf (TASK-068) + scales/active (TASK-051) + stats/period (TASK-054) + trend/series (TASK-056) + updates/check|download|install (TASK-096) + vault/status|unlock|lock|set-passphrase (TASK-094)', () => {
    expect(Object.keys(CHANNEL_SCHEMAS)).toEqual([
      '__bench/seed',
      // TASK-102 §5/§11: TEST-ONLY крэш-тест потери питания (NFR-3) — батч-вставка
      // и снимок состояния БД; регистрация — только при env HL_TEST_HOOKS=1.
      '__test/insert-batch',
      '__test/db-state',
      'ai/models/list',
      'ai/models/download',
      'ai/models/pause',
      'ai/models/resume',
      'ai/models/reset',
      'ai/models/select',
      'ai/context/preview',
      'ai/summary/generate',
      'ai/summary/latest',
      'ai/summary/delete-all',
      'ai/chat/send',
      'ai/chat/clear',
      'ai/chat/list',
      'ai/cancel',
      'app/ping',
      'app/log-client-error',
      'app/reveal-path',
      'app/heartbeat',
      // TASK-100 §5/§11: сампроверка старта, версии «О приложении», полная проверка БД.
      'app/selfcheck',
      'app/meta',
      // TASK-101 §5/§9: «Открыть папку с копиями» recovery-экрана.
      'app/reveal-backups',
      'app/integrity-full',
      'backup/create',
      'backup/restore',
      // TASK-101 §5/§9: «начать заново» — wipe-подмножество recovery.
      'data/discard-db',
      'data/wipe',
      // TASK-103 §5/§11: диагностический пакет — предпросмотр и сохранение zip.
      'diag/preview',
      'diag/save',
      'file/open-dialog',
      'measurements/add',
      'measurements/list',
      'measurements/update',
      'measurements/delete',
      'notes/search',
      'prefs/get',
      'prefs/set',
      'privacy/journal',
      'privacy/consents',
      'report/export-csv',
      'report/export-json',
      'report/pdf',
      'scales/active',
      'stats/period',
      'trend/series',
      'updates/check',
      'updates/download',
      'updates/install',
      'vault/status',
      'vault/unlock',
      'vault/lock',
      'vault/set-passphrase',
    ]);
  });

  it('каждый канал несёт пару схем request/response', () => {
    for (const schemas of Object.values(CHANNEL_SCHEMAS)) {
      expect(typeof schemas.request.parse).toBe('function');
      expect(typeof schemas.response.parse).toBe('function');
    }
  });
});
