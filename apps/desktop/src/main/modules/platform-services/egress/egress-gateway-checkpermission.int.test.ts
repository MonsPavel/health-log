// TASK-096 §6/§19/§20: интеграционные тесты расширения EgressGateway —
// checkPermission(op): {allowed, journal} — единая точка решения политики/согласия
// и журналирования для потребителей, чья сеть идёт ВНУТРИ стороннего исполнителя
// (electron-updater — gateway физически не проведёшь, §4): разрешение → журнал
// running→ok/failed через gateway-journal API; отказ → blocked-запись (как в 075,
// §13 «журнал blocked»).
//
// Матрица:
//  1. op вне белого списка / без согласия → {allowed: false}, blocked-запись в
//     журнале, net:activity доставлен; журнал-заглушка отказа — строгая (вызов —
//     TypeError: программная ошибка потребителя);
//  2. разрешено, journal.start(endpoint) → running-запись + лента; ok()/failed()
//     обновляют ТУ ЖЕ запись; байты updater'а не наблюдаемы — ok() без bytes → NULL
//     (§22 TASK-096);
//  3. start() без разрешения операции СЕТЬ не открывает: разрешение выдано, journal
//     не тронут — записей нет (проверка может завершиться до сети — throttle, §13);
//  4. нарушения контракта журнала (двойной start, ok/failed без start, повторный
//     финал) — TypeError (прецедент listRecent, §13).
//
// Хелперы (tmp-БД, fake-окно) повторяют egress-gateway.int.test.ts: импорт
// тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия
// (прецедент container-egress.int.test.ts).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { HL_EVENT_CHANNEL, type NetConsents } from '@hl/contracts';
import { FixedClock } from '@hl/kernel';

import { createBroadcastToWindows, type BroadcastTarget } from '../../../events/broadcast.js';
import { silentLogger } from '../../../shared/logger/silent-logger.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { EgressGateway } from './egress-gateway.js';

const dirs: string[] = [];

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
  readonly envelopes: { channel: string; envelope: unknown }[];
  /** Мутабельные согласия — перечитываются на каждую проверку (§14). */
  consents: NetConsents;
}

const makeFixture = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-egress-checkpermission-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, 'egress.sqlite'), randomBytes(32).toString('hex'));
  new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
  const consents: NetConsents = { updatesCheck: true, modelsDownload: true };
  const { target, envelopes } = makeFakeWindow();
  const notify = createBroadcastToWindows({
    getAllTargets: () => [target],
    logger: silentLogger(),
  });
  const gateway = new EgressGateway({
    db,
    clock: new FixedClock(1_758_816_000_000, 180),
    logger: silentLogger(),
    consents: () => Promise.resolve(consents),
    // Сеть в этих тестах не вызывается НИКОГДА: checkPermission не выполняет
    // запросов — только решение + журнал (§4: сеть — дело потребителя).
    fetch: () => {
      throw new Error('checkPermission не должен выполнять сетевых запросов');
    },
    notify,
  });
  return { db, gateway, envelopes, consents };
};

const journalRows = (db: EncryptedDatabase): {
  kind: string;
  endpoint: string;
  status: string;
  bytes: number | null;
}[] =>
  db
    .prepare('SELECT kind, endpoint, status, bytes FROM network_event ORDER BY at_utc, id')
    .all() as { kind: string; endpoint: string; status: string; bytes: number | null }[];

describe('EgressGateway.checkPermission — единая точка решения + журнал (TASK-096 §4/§6)', () => {
  it('(1) op вне белого списка → {allowed: false}, blocked-запись, лента; журнал-заглушка строгая (§9/AC1)', async () => {
    const fx = makeFixture();
    fx.consents.updatesCheck = true;

    const permission = await fx.gateway.checkPermission('site.sync');

    expect(permission.allowed).toBe(false);
    expect(fx.gateway.listRecent(1)).toHaveLength(1);
    expect(journalRows(fx.db)).toEqual([
      { kind: 'site.sync', endpoint: '', status: 'blocked', bytes: null },
    ]);
    expect(fx.envelopes).toEqual([
      {
        channel: HL_EVENT_CHANNEL,
        envelope: { name: 'net:activity', payload: { kind: 'site.sync', endpoint: '' } },
      },
    ]);
    // Заглушка отказа не притворяется рабочим журналом: вызов — программная ошибка.
    expect(() => permission.journal.start('https://releases.example.com/latest')).toThrow(
      TypeError,
    );
    fx.db.close();
  });

  it('(2) согласие не выдано (updatesCheck=false) → {allowed: false}, blocked-запись kind updates.check (AC1, §13 «журнал blocked — как в 075»)', async () => {
    const fx = makeFixture();
    fx.consents.updatesCheck = false;

    const permission = await fx.gateway.checkPermission('updates.check');

    expect(permission.allowed).toBe(false);
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: '', status: 'blocked', bytes: null },
    ]);
    fx.db.close();
  });

  it('(3) разрешено → journal.start пишет running (endpoint фида) + лента; ok() обновляет ТУ ЖЕ запись; байты updater-а не наблюдаемы — NULL (§22)', async () => {
    const fx = makeFixture();

    const permission = await fx.gateway.checkPermission('updates.check');
    expect(permission.allowed).toBe(true);
    // Разрешение без start() — записи нет (проверка может не дойти до сети, §13).
    expect(journalRows(fx.db)).toEqual([]);

    permission.journal.start('https://releases.example.com/latest');
    permission.journal.ok();

    expect(journalRows(fx.db)).toEqual([
      {
        kind: 'updates.check',
        endpoint: 'https://releases.example.com/latest',
        status: 'ok',
        bytes: null,
      },
    ]);
    expect(fx.envelopes).toEqual([
      {
        channel: HL_EVENT_CHANNEL,
        envelope: {
          name: 'net:activity',
          payload: { kind: 'updates.check', endpoint: 'https://releases.example.com/latest' },
        },
      },
    ]);
    fx.db.close();
  });

  it('(4) journal.failed() — сетевая неудача проверки → failed-запись (§9: статус error, журнал failed)', async () => {
    const fx = makeFixture();

    const permission = await fx.gateway.checkPermission('updates.check');
    permission.journal.start('https://releases.example.com/latest');
    permission.journal.failed();

    expect(journalRows(fx.db)).toEqual([
      {
        kind: 'updates.check',
        endpoint: 'https://releases.example.com/latest',
        status: 'failed',
        bytes: null,
      },
    ]);
    fx.db.close();
  });

  it('(5) нарушения контракта журнала — TypeError: двойной start, ok без start, повторный финал (§13)', async () => {
    const fx = makeFixture();

    const permission = await fx.gateway.checkPermission('updates.check');
    expect(() => permission.journal.ok()).toThrow(TypeError);

    permission.journal.start('https://releases.example.com/latest');
    expect(() => permission.journal.start('https://other.example.com/latest')).toThrow(TypeError);
    permission.journal.ok();
    expect(() => permission.journal.ok()).toThrow(TypeError);
    fx.db.close();
  });

  it('(6) разрешение перечитывает согласие на каждый вызов — отзыв мгновенно блокирует следующую проверку (§14)', async () => {
    const fx = makeFixture();

    expect((await fx.gateway.checkPermission('updates.check')).allowed).toBe(true);
    fx.consents.updatesCheck = false;
    expect((await fx.gateway.checkPermission('updates.check')).allowed).toBe(false);
    fx.consents.updatesCheck = true;
    expect((await fx.gateway.checkPermission('updates.check')).allowed).toBe(true);
    // Blocked-запись ровно одна — за единственный отказ (§9).
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: '', status: 'blocked', bytes: null },
    ]);
    fx.db.close();
  });
});
