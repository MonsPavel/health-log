// TASK-075 §19/§20: интеграционные тесты EgressGateway — tmp-БД (миграция v5),
// РЕАЛЬНЫЙ трафик через локальный http-мок-сервер (node:http) и реальный мост
// broadcast (fake webContents со шпионом send — прецедент TASK-009).
//
// Матрица веток §13 (§20 AC1–AC4):
//  1. op вне белого списка → NET/BLOCKED_BY_POLICY {op}, журнал blocked, fetch НЕ
//     вызывается (отказ БЫСТРЫЙ, до сети — §9);
//  2. op в списке, согласия нет → NET/BLOCKED_BY_POLICY {op}, журнал blocked, fetch
//     НЕ вызывается; отмена согласия мгновенно блокирует СЛЕДУЮЩИЙ запрос (§14 —
//     consents перечитывается на каждый request);
//  3. согласие есть → реальный запрос на мок-сервер: Response возвращён вызывающему,
//     running-запись журнала ОБНОВЛЕНА (status ok, bytes = content-length, at —
//     момент завершения), net:activity доставлен renderer'у через мост broadcast
//     (конверт {name, payload} на канале hl:event — AC4);
//  4. сетевая ошибка → статус failed в журнале, ошибка ПРОБРОШЕНА вызывающему (§13).
// Плюс: helper listRecent(limit) — последние N, новые раньше (§5).
//
// PHI (§7): в журнал пишутся только kind/endpoint/status/bytes/at — тест (3)
// проверяет состав колонок записи (URL CDN — метаданные, без тел запросов).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import { HL_EVENT_CHANNEL, type NetConsents } from '@hl/contracts';
import { AppError, FixedClock, type Clock } from '@hl/kernel';

import { createBroadcastToWindows, type BroadcastTarget } from '../../../events/broadcast.js';
import type { EventsLogger } from '../../../events/event-bus.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { EgressPolicy, NET_BLOCKED_BY_POLICY_MESSAGE_KEY } from './egress-policy.js';
import { EgressGateway } from './egress-gateway.js';

/** tmp-каталоги сессии — удаление в afterAll (§14). */
const dirs: string[] = [];

/** http-мок-сервер (§19): один на файл, endpoint — /models/llm.bin с content-length. */
let server: Server;
let endpoint = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = JSON.stringify({ ok: true, url: request.url });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('мок-сервер: ожидается AddressInfo (listen на порту 0)');
  }
  endpoint = `http://127.0.0.1:${address.port}/models/llm.bin`;
});

afterAll(async () => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/** Логгер-молчун для моста broadcast (§19; интерфейс EventsLogger TASK-009). */
const silentEventsLogger: EventsLogger = {
  debug: () => undefined,
  error: () => undefined,
};

/**
 * Реальный HTTP-клиент теста (§19 «трафик реальный через gateway»): loopback-запрос
 * node:http к мок-серверу, ответ — настоящий Response (с content-length мок-сервера).
 * Глобальный fetch в тестах ЗАБЛОКИРОВАН guard'ом FR-7.2 (vitest.setup, «звонок
 * домой» невозможен) — это не обход: loopback на локальный мок-сервер и есть
 * «мок-сервер http как endpoint» §19, а guard продолжает ловить прочие тесты.
 */
const httpFetch = (endpoint: string, init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string> | undefined) ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              headers.set(name, value);
            } else if (Array.isArray(value)) {
              for (const item of value) {
                headers.append(name, item);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 200, headers }));
        });
      },
    );
    req.on('error', reject);
    req.end(init?.body);
  });

/**
 * Fake-окно (webContents со шпионом send) — приёмник моста broadcast (§19/AC4:
 * «net:activity доходит в renderer»).
 */
const makeFakeWindow = (): {
  target: BroadcastTarget;
  envelopes: { channel: string; envelope: unknown }[];
} => {
  const envelopes: { channel: string; envelope: unknown }[] = [];
  const target: BroadcastTarget = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      envelopes.push({ channel, envelope: payload });
    },
    once: () => undefined,
  };
  return { target, envelopes };
};

interface Fixture {
  readonly db: EncryptedDatabase;
  readonly gateway: EgressGateway;
  readonly fetchSpy: Mock<(endpoint: string, init?: RequestInit) => Promise<Response>>;
  /** Подмена исполнителя (§19): боевой в тесте — loopback-клиент httpFetch. */
  readonly setFetch: (impl: (endpoint: string, init?: RequestInit) => Promise<Response>) => void;
  readonly envelopes: { channel: string; envelope: unknown }[];
  /** Мутабельные согласия — перечитываются на каждый request (§14). */
  consents: NetConsents;
}

/** Полная фикстура: tmp-БД v5 + gateway с реальным мостом broadcast на fake-окно. */
const makeFixture = (clock: Clock = new FixedClock(1_758_816_000_000, 180)): Promise<Fixture> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-egress-gateway-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, 'egress.sqlite'), randomBytes(32).toString('hex'));
  return new MigrationRunner({ migrations: MIGRATIONS }).migrate(db).then(() => {
    const consents: NetConsents = { updatesCheck: true, modelsDownload: true };
    let fetchImpl: (endpoint: string, init?: RequestInit) => Promise<Response> = () =>
      Promise.reject(new Error('fetch не должен вызываться в этом тесте'));
    const fetchSpy: Mock<(endpoint: string, init?: RequestInit) => Promise<Response>> = vi.fn(
      (endpoint: string, init?: RequestInit) => fetchImpl(endpoint, init),
    );
    const setFetch = (impl: (endpoint: string, init?: RequestInit) => Promise<Response>): void => {
      fetchImpl = impl;
    };
    const { target, envelopes } = makeFakeWindow();
    const notify = createBroadcastToWindows({
      getAllTargets: () => [target],
      logger: silentEventsLogger,
    });
    const gateway = new EgressGateway({
      db,
      clock,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        trace: () => undefined,
        fatal: () => undefined,
      },
      consents: () => Promise.resolve(consents),
      fetch: fetchSpy,
      notify,
    });
    return { db, gateway, fetchSpy, setFetch, envelopes, consents };
  });
};

/** Записи журнала (полный состав колонок — §7). */
const journalRows = (
  db: EncryptedDatabase,
): {
  id: string;
  kind: string;
  endpoint: string;
  status: string;
  bytes: number | null;
  at_utc: number;
}[] =>
  db
    .prepare(
      'SELECT id, kind, endpoint, status, bytes, at_utc FROM network_event ORDER BY at_utc, id',
    )
    .all() as {
    id: string;
    kind: string;
    endpoint: string;
    status: string;
    bytes: number | null;
    at_utc: number;
  }[];

describe('EgressGateway — ветки §13 (TASK-075 §19/§20)', () => {
  it('(1) op вне белого списка → NET/BLOCKED_BY_POLICY {op}, журнал blocked, до сети дело не доходит (AC1)', async () => {
    const fx = await makeFixture();

    const error: AppError = await fx.gateway
      .request('site.sync', { endpoint: 'https://sync.example.com/v1' })
      .then(
        () => {
          throw new Error('ожидался отказ NET/BLOCKED_BY_POLICY');
        },
        (cause: unknown) => cause as AppError,
      );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NET/BLOCKED_BY_POLICY');
    expect(error.messageKey).toBe(NET_BLOCKED_BY_POLICY_MESSAGE_KEY);
    expect(error.params).toEqual({ op: 'site.sync' });
    expect(fx.fetchSpy).not.toHaveBeenCalled();

    const rows = journalRows(fx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'site.sync',
      endpoint: 'https://sync.example.com/v1',
      status: 'blocked',
      bytes: null,
    });
    fx.db.close();
  });

  it('(2) op в списке, согласия нет → NET/BLOCKED_BY_POLICY {op}, журнал blocked; согласие отозвано → следующий запрос тоже blocked (AC1, §14)', async () => {
    const fx = await makeFixture();
    fx.consents.updatesCheck = false;

    const error: AppError = await fx.gateway
      .request('updates.check', { endpoint: 'https://releases.example.com/latest' })
      .then(
        () => {
          throw new Error('ожидался отказ NET/BLOCKED_BY_POLICY');
        },
        (cause: unknown) => cause as AppError,
      );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NET/BLOCKED_BY_POLICY');
    expect(error.params).toEqual({ op: 'updates.check' });
    expect(fx.fetchSpy).not.toHaveBeenCalled();
    expect(journalRows(fx.db)).toHaveLength(1);
    expect(journalRows(fx.db)[0]).toMatchObject({ kind: 'updates.check', status: 'blocked' });

    // §14: согласие вернули — СЛЕДУЮЩИЙ запрос проходит (consents перечитываются).
    fx.consents.updatesCheck = true;
    fx.setFetch(() => Promise.resolve(new Response('{}', { status: 200 })));
    await expect(
      fx.gateway.request('updates.check', { endpoint: 'https://releases.example.com/latest' }),
    ).resolves.toBeInstanceOf(Response);
    expect(fx.fetchSpy).toHaveBeenCalledTimes(1);
    fx.db.close();
  });

  it('(3) согласие есть → реальный запрос на мок-сервер: Response возвращён, журнал обновлён (running→ok, bytes, at), net:activity через мост в fake-окно (AC2/AC4)', async () => {
    const startMs = 1_758_816_000_000;
    const fx = await makeFixture(new FixedClock(startMs, 180));
    // Реальный трафик (§19): fetch-деп — loopback-клиент node:http к мок-серверу.
    fx.setFetch(httpFetch);

    const response = await fx.gateway.request('models.download', { endpoint });

    expect(response).toBeInstanceOf(Response);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(JSON.stringify({ ok: true, url: '/models/llm.bin' }));
    expect(fx.fetchSpy).toHaveBeenCalledWith(endpoint, undefined);

    const rows = journalRows(fx.db);
    expect(rows).toHaveLength(1); // running-запись ОБНОВЛЕНА, а не продублирована (§5 п. 3)
    expect(rows[0]).toMatchObject({
      kind: 'models.download',
      endpoint,
      status: 'ok',
      bytes: Buffer.byteLength(JSON.stringify({ ok: true, url: '/models/llm.bin' })),
    });
    expect(rows[0]!.at_utc).toBeGreaterThanOrEqual(startMs);

    // AC4: событие доставлено renderer'у — конверт моста на едином канале (§11).
    expect(fx.envelopes).toEqual([
      {
        channel: HL_EVENT_CHANNEL,
        envelope: { name: 'net:activity', payload: { kind: 'models.download', endpoint } },
      },
    ]);
    fx.db.close();
  });

  it('(4) сетевая ошибка → статус failed, ошибка проброшена вызывающему (§13/AC1)', async () => {
    const fx = await makeFixture();
    // Реальная сетевая неудача: порт без слушателя (сервер из beforeAll занимает свой).
    fx.setFetch(httpFetch);
    const deadServer = createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
    const deadAddress = deadServer.address();
    if (deadAddress === null || typeof deadAddress === 'string') {
      throw new TypeError('мок-сервер: ожидается AddressInfo');
    }
    const deadEndpoint = `http://127.0.0.1:${deadAddress.port}/gone.bin`;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    await expect(fx.gateway.request('models.download', { endpoint: deadEndpoint })).rejects.toThrow(
      /fetch failed|ECONNREFUSED/i,
    );

    const rows = journalRows(fx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'models.download',
      endpoint: deadEndpoint,
      status: 'failed',
      bytes: null,
    });
    fx.db.close();
  });

  it('(5) listRecent(limit) — последние N записей, новые раньше (§5)', async () => {
    // Часы с шагом: детерминированный порядок at_utc для сортировки listRecent.
    let now = 1_000;
    const steppingClock: Clock = {
      nowMs: () => (now += 100),
      tzOffsetMin: () => 180,
    };
    const fx = await makeFixture(steppingClock);
    fx.setFetch(() => Promise.resolve(new Response('', { status: 200 })));
    await fx.gateway.request('updates.check', { endpoint: 'https://releases.example.com/1' });
    // blocked-ветка ОТКАЗЫВАЕТ (AppError) — в журнале запись при этом появляется (§9).
    await fx.gateway
      .request('site.sync', { endpoint: 'https://sync.example.com' })
      .catch(() => undefined);
    await fx.gateway.request('models.download', { endpoint: 'https://cdn.example.com/2' });

    const recent = fx.gateway.listRecent(2);
    expect(recent.map((row) => row.kind)).toEqual(['models.download', 'site.sync']);
    expect(recent[0]).toMatchObject({ status: 'ok', endpoint: 'https://cdn.example.com/2' });
    fx.db.close();
  });

  it('(6) EgressPolicy — белый список §5: только models.download/updates.check с consentKey prefs', () => {
    expect(EgressPolicy.ALLOWED['models.download']).toEqual({ consentKey: 'modelsDownload' });
    expect(EgressPolicy.ALLOWED['updates.check']).toEqual({ consentKey: 'updatesCheck' });
    expect(Object.keys(EgressPolicy.ALLOWED).sort()).toEqual(['models.download', 'updates.check']);
  });
});
