// TASK-096 §19/§20: тесты UpdatesService — РЕАЛЬНЫЙ EgressGateway над tmp-БД
// (журнал network_event v5, согласия — мутабельный срез) + fake-окно broadcast +
// UpdatesAdapter-мок (интерфейс-обёртка updater'а, §19), эмулирующий поведение
// electron-updater: исход checkForUpdates + события update-available/…-downloaded.
//
// Приёмка §20:
//  AC1 — без согласия: 0 вызовов checkForUpdates; журнал содержит blocked;
//  AC2 — с согласием: проверка → событие update:available → журнал ok;
//  AC3 — конфиг updater'а: autoDownload=false (+disableWebInstaller) — describe B;
//  AC4 — планировщик: без согласия тик молчит; с согласием — раз в 24 ч — describe C;
//  AC5 — ошибка сети → {status:'error'} (не креш); throttle повторов 10 мин;
//  AC6 — install без ready → отказ UPD/NOT_READY.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { HL_EVENT_CHANNEL, PREFS_SCHEMA, type NetConsents, type Prefs } from '@hl/contracts';
import { AppError, type Clock, type Instant } from '@hl/kernel';

import { createBroadcastToWindows, type BroadcastTarget } from '../../../events/broadcast.js';
import { silentLogger } from '../../../shared/logger/silent-logger.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { EgressGateway } from '../egress/egress-gateway.js';
import { JobScheduler, type JobPrefsStore, type JobShowSink } from '../../../shared/scheduler/scheduler.js';
import {
  UPD_NOT_READY_MESSAGE_KEY,
  UPDATES_AUTO_CHECK_INTERVAL_MS,
  UPDATES_CHECK_JOB_NAME,
  UpdatesService,
  createUpdatesCheckJob,
  wireElectronUpdater,
  type ElectronUpdaterLike,
  type UpdateCheckOutcome,
  type UpdatesAdapter,
} from './updates-service.js';

const dirs: string[] = [];
const FEED_URL = 'https://releases.example.com/latest';
const T0 = 1_758_816_000_000;
const MINUTE_MS = 60_000;

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

/**
 * UpdatesAdapter-мок (§19): считает вызовы, эмулирует поведение боевого updater'а —
 * исход checkForUpdates сопровождается событием (available/not-available), финал
 * downloadUpdate — прогрессом и update-downloaded (как у autoUpdater).
 */
class FakeUpdatesAdapter implements UpdatesAdapter {
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;

  private lastAvailableVersion: string | undefined;
  private checkImpl: () => Promise<UpdateCheckOutcome> = () =>
    Promise.resolve({ available: false });
  private downloadImpl: () => Promise<void> = () => Promise.resolve();
  private readonly listeners = {
    available: [] as ((version: string) => void)[],
    notAvailable: [] as (() => void)[],
    progress: [] as ((percent: number) => void)[],
    downloaded: [] as ((version: string) => void)[],
    error: [] as ((cause: unknown) => void)[],
  };

  setCheckOutcome(outcome: UpdateCheckOutcome): void {
    this.checkImpl = () => Promise.resolve(outcome);
  }

  setCheckFailure(cause: unknown): void {
    this.checkImpl = () => Promise.reject(cause);
  }

  setDownloadFailure(cause: unknown): void {
    this.downloadImpl = () => Promise.reject(cause);
  }

  async getFeedUrl(): Promise<string> {
    return FEED_URL;
  }

  async checkForUpdates(): Promise<UpdateCheckOutcome> {
    this.checkCalls += 1;
    const outcome = await this.checkImpl();
    if (outcome.available && outcome.version !== undefined) {
      this.lastAvailableVersion = outcome.version;
      this.fireAvailable(outcome.version);
    } else {
      this.fireNotAvailable();
    }
    return outcome;
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
    await this.downloadImpl();
    this.fireProgress(100);
    this.fireDownloaded(this.lastAvailableVersion ?? '0.0.0');
  }

  async quitAndInstall(): Promise<void> {
    this.installCalls += 1;
  }

  onAvailable(listener: (version: string) => void): void {
    this.listeners.available.push(listener);
  }

  onNotAvailable(listener: () => void): void {
    this.listeners.notAvailable.push(listener);
  }

  onDownloadProgress(listener: (percent: number) => void): void {
    this.listeners.progress.push(listener);
  }

  onDownloaded(listener: (version: string) => void): void {
    this.listeners.downloaded.push(listener);
  }

  onError(listener: (cause: unknown) => void): void {
    this.listeners.error.push(listener);
  }

  fireAvailable(version: string): void {
    for (const listener of this.listeners.available) listener(version);
  }

  fireNotAvailable(): void {
    for (const listener of this.listeners.notAvailable) listener();
  }

  fireProgress(percent: number): void {
    for (const listener of this.listeners.progress) listener(percent);
  }

  fireDownloaded(version: string): void {
    for (const listener of this.listeners.downloaded) listener(version);
  }

  fireError(cause: unknown): void {
    for (const listener of this.listeners.error) listener(cause);
  }
}

interface Fixture {
  readonly db: EncryptedDatabase;
  readonly service: UpdatesService;
  readonly adapter: FakeUpdatesAdapter;
  readonly envelopes: { channel: string; envelope: unknown }[];
  readonly consents: NetConsents;
  readonly advance: (ms: number) => void;
}

/** Полная фикстура: tmp-БД v5 + реальный gateway + fake-окно + adapter-мок. */
const makeFixture = async (consents: NetConsents): Promise<Fixture> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-updates-service-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, 'updates.sqlite'), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
  const { target, envelopes } = makeFakeWindow();
  const notify = createBroadcastToWindows({
    getAllTargets: () => [target],
    logger: silentLogger(),
  });
  // Мутабельные часы: throttle §13 двигается тестом (advance), NFR-10.
  const clockState = { now: T0 };
  const mutableClock: Clock = { nowMs: () => clockState.now, tzOffsetMin: () => 180 };
  const gateway = new EgressGateway({
    db,
    clock: mutableClock,
    logger: silentLogger(),
    consents: () => Promise.resolve(consents),
    fetch: () => {
      throw new Error('updates-тесты не ходят в сеть через gateway.request');
    },
    notify,
  });
  const adapter = new FakeUpdatesAdapter();
  const service = new UpdatesService({
    adapter,
    gateway,
    clock: mutableClock,
    logger: silentLogger(),
    notify,
  });
  return {
    db,
    service,
    adapter,
    envelopes,
    consents,
    advance: (ms: number) => {
      clockState.now += ms;
    },
  };
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

const eventNames = (envelopes: { channel: string; envelope: unknown }[]): string[] =>
  envelopes.map((envelope) => (envelope.envelope as { name: string }).name);

describe('UpdatesService — проверка за согласием (TASK-096 §20 AC1/AC2)', () => {
  it('(AC1) без согласия: check отклоняет NET/BLOCKED_BY_POLICY {op}, 0 вызовов checkForUpdates, журнал blocked (§13)', async () => {
    const fx = await makeFixture({ updatesCheck: false, modelsDownload: false });

    const error: AppError = await fx.service.check().then(
      () => {
        throw new Error('ожидался отказ NET/BLOCKED_BY_POLICY');
      },
      (cause: unknown) => cause as AppError,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NET/BLOCKED_BY_POLICY');
    expect(error.params).toEqual({ op: 'updates.check' });
    expect(fx.adapter.checkCalls).toBe(0);
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: '', status: 'blocked', bytes: null },
    ]);
    fx.db.close();
  });

  it('отзыв согласия мгновенен: ok-проверка, потом revoke → отказ и blocked-запись (§3)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: false });

    await expect(fx.service.check()).resolves.toEqual({ status: 'latest' });
    fx.consents.updatesCheck = false;
    await expect(fx.service.check()).rejects.toBeInstanceOf(AppError);

    expect(fx.adapter.checkCalls).toBe(1);
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: FEED_URL, status: 'ok', bytes: null },
      { kind: 'updates.check', endpoint: '', status: 'blocked', bytes: null },
    ]);
    fx.db.close();
  });

  it('(AC2) с согласием available: результат {status, version}, событие update:available, журнал running→ok (байты updater-а NULL — §22)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: true, version: '1.2.3' });

    await expect(fx.service.check()).resolves.toEqual({ status: 'available', version: '1.2.3' });

    expect(fx.adapter.checkCalls).toBe(1);
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: FEED_URL, status: 'ok', bytes: null },
    ]);
    expect(eventNames(fx.envelopes)).toContain('update:available');
    expect(
      fx.envelopes.find((envelope) => (envelope.envelope as { name: string }).name === 'update:available'),
    ).toEqual({
      channel: HL_EVENT_CHANNEL,
      envelope: { name: 'update:available', payload: { version: '1.2.3' } },
    });
    expect(fx.service.getStatus()).toEqual({ state: 'available', version: '1.2.3' });
    fx.db.close();
  });

  it('update-not-available → {status: "latest"} без события update:available (§11)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: false });

    await expect(fx.service.check()).resolves.toEqual({ status: 'latest' });

    expect(eventNames(fx.envelopes)).not.toContain('update:available');
    expect(fx.service.getStatus().state).toBe('latest');
    fx.db.close();
  });
});

describe('UpdatesService — ошибка сети и throttle (TASK-096 §20 AC5, §13)', () => {
  it('(AC5) сеть падает → {status: "error"} (резолв, не креш), журнал failed, статус error (§9)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckFailure(new Error('fetch failed'));

    await expect(fx.service.check()).resolves.toEqual({ status: 'error' });

    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: FEED_URL, status: 'failed', bytes: null },
    ]);
    expect(fx.service.getStatus().state).toBe('error');
    fx.db.close();
  });

  it('throttle повторов: сразу после ошибки проверка не доходит до сети; через 10 мин — доходит (§13)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckFailure(new Error('fetch failed'));
    await fx.service.check();
    expect(fx.adapter.checkCalls).toBe(1);

    fx.advance(MINUTE_MS);
    await expect(fx.service.check()).resolves.toEqual({ status: 'error' });
    expect(fx.adapter.checkCalls).toBe(1); // сеть не тронута
    expect(journalRows(fx.db)).toHaveLength(1); // дублей журнала нет

    fx.advance(10 * MINUTE_MS);
    await expect(fx.service.check()).resolves.toEqual({ status: 'error' });
    expect(fx.adapter.checkCalls).toBe(2); // backoff истёк — повтор разрешён
    expect(journalRows(fx.db)).toHaveLength(2);
    fx.db.close();
  });

  it('throttle — только после ОШИБКИ: две успешные проверки подряд идут в сеть (§13 backoff, не общий лимит)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: false });

    await fx.service.check();
    await fx.service.check();

    expect(fx.adapter.checkCalls).toBe(2);
    fx.db.close();
  });
});

describe('UpdatesService — download/install (TASK-096 §20 AC6, §13)', () => {
  it('download: то же согласие updatesCheck (§5 РЕШЕНИЕ), прогресс и ready событиями, журнал — вторая ok-запись', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: true, version: '1.2.3' });
    await fx.service.check();

    await expect(fx.service.download()).resolves.toEqual({ status: 'ready', version: '1.2.3' });

    expect(fx.adapter.downloadCalls).toBe(1);
    expect(eventNames(fx.envelopes)).toEqual(
      expect.arrayContaining(['update:progress', 'update:ready']),
    );
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: FEED_URL, status: 'ok', bytes: null },
      { kind: 'updates.check', endpoint: FEED_URL, status: 'ok', bytes: null },
    ]);
    expect(fx.service.getStatus()).toEqual({ state: 'ready', version: '1.2.3' });
    fx.db.close();
  });

  it('download при уже готовом обновлении — идемпотентен: сети и журнала нет (§13)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: true, version: '1.2.3' });
    await fx.service.check();
    await fx.service.download();

    await expect(fx.service.download()).resolves.toEqual({ status: 'ready', version: '1.2.3' });

    expect(fx.adapter.downloadCalls).toBe(1);
    expect(journalRows(fx.db)).toHaveLength(2);
    fx.db.close();
  });

  it('download без согласия — отказ NET/BLOCKED_BY_POLICY, downloadUpdate не вызван (§5/§14)', async () => {
    const fx = await makeFixture({ updatesCheck: false, modelsDownload: false });

    await expect(fx.service.download()).rejects.toBeInstanceOf(AppError);
    expect(fx.adapter.downloadCalls).toBe(0);
    expect(journalRows(fx.db)).toEqual([
      { kind: 'updates.check', endpoint: '', status: 'blocked', bytes: null },
    ]);
    fx.db.close();
  });

  it('download падает → {status: "error"} + журнал failed (§9)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: true, version: '1.2.3' });
    await fx.service.check();
    fx.adapter.setDownloadFailure(new Error('download failed'));

    await expect(fx.service.download()).resolves.toEqual({ status: 'error' });

    expect(journalRows(fx.db)[1]).toMatchObject({ kind: 'updates.check', status: 'failed' });
    fx.db.close();
  });

  it('(AC6) install без скачанного — отказ UPD/NOT_READY, quitAndInstall не вызван (§13)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: true, version: '1.2.3' });
    await fx.service.check();

    const error: AppError = await fx.service.install().then(
      () => {
        throw new Error('ожидался отказ UPD/NOT_READY');
      },
      (cause: unknown) => cause as AppError,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('UPD/NOT_READY');
    expect(error.messageKey).toBe(UPD_NOT_READY_MESSAGE_KEY);
    expect(fx.adapter.installCalls).toBe(0);
    fx.db.close();
  });

  it('install после downloaded → {restarting: true}, quitAndInstall вызван (updater сам перезапускает, §13)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: true, version: '1.2.3' });
    await fx.service.check();
    await fx.service.download();

    await expect(fx.service.install()).resolves.toEqual({ restarting: true });
    expect(fx.adapter.installCalls).toBe(1);
    fx.db.close();
  });

  it('асинхронная ошибка updater-а вне операции — статус error, сервис жив (не креш, §9)', async () => {
    const fx = await makeFixture({ updatesCheck: true, modelsDownload: false });
    fx.adapter.setCheckOutcome({ available: false });

    fx.adapter.fireError(new Error('late failure'));
    expect(fx.service.getStatus().state).toBe('error');

    await expect(fx.service.check()).resolves.toEqual({ status: 'latest' });
    expect(fx.adapter.checkCalls).toBe(1); // error-событие НЕ включает throttle
    fx.db.close();
  });
});

describe('wireElectronUpdater — конфиг и маппинг боевого updater-а (TASK-096 §20 AC3, §4/§14)', () => {
  /** Fake electron-updater: структурная поверхность ElectronUpdaterLike (§19). */
  const makeFakeUpdater = (): ElectronUpdaterLike & {
    emit: (event: string, ...args: unknown[]) => void;
  } => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
      autoDownload: true,
      disableWebInstaller: false,
      checkForUpdates: () => Promise.resolve(null),
      downloadUpdate: () => Promise.resolve([]),
      quitAndInstall: () => undefined,
      getFeedURL: () => FEED_URL,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
        return undefined;
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
  };

  it('(AC3) конфиг: autoDownload=false, disableWebInstaller=true — никаких фоновых загрузок (§4/§14)', () => {
    const updater = makeFakeUpdater();
    wireElectronUpdater(updater, silentLogger());
    expect(updater.autoDownload).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
  });

  it('маппинг исхода: {isUpdateAvailable, updateInfo.version} → {available, version}; null → latest', async () => {
    const updater = makeFakeUpdater();
    updater.checkForUpdates = () =>
      Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } });
    const adapter = wireElectronUpdater(updater, silentLogger());

    await expect(adapter.checkForUpdates()).resolves.toEqual({
      available: true,
      version: '9.9.9',
    });
    await expect(adapter.getFeedUrl()).resolves.toBe(FEED_URL);
  });

  it('маппинг событий: update-available/download-progress/update-downloaded/error доходят до подписчиков сервиса', () => {
    const updater = makeFakeUpdater();
    const adapter = wireElectronUpdater(updater, silentLogger());
    const seen: string[] = [];
    adapter.onAvailable((version) => seen.push(`available:${version}`));
    adapter.onDownloadProgress((percent) => seen.push(`progress:${String(percent)}`));
    adapter.onDownloaded((version) => seen.push(`downloaded:${version}`));
    adapter.onError((cause) => seen.push(`error:${String((cause as Error).message)}`));

    updater.emit('update-available', { version: '2.0.0' });
    updater.emit('download-progress', { percent: 42 });
    updater.emit('update-downloaded', { version: '2.0.0' });
    updater.emit('error', new Error('boom'));

    expect(seen).toEqual(['available:2.0.0', 'progress:42', 'downloaded:2.0.0', 'error:boom']);
  });
});

describe('createUpdatesCheckJob — авто-проверка на каркасе 074 (TASK-096 §20 AC4)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const instantAt = (utcMs: number): Instant => ({ utcMs, tzOffsetMin: 180 });

  /** Fake prefs-store (§19, прецедент scheduler.test.ts) + мутабельные согласия. */
  const makeStore = (consents: NetConsents): { store: JobPrefsStore; patches: Prefs[] } => {
    // netConsents — ЖИВАЯ ссылка на объект консентов (parse копирует): в боевом
    // графе и gateway, и задача читают один документ PreferencesService (§14).
    let current: Prefs = { ...PREFS_SCHEMA.parse({}), netConsents: consents };
    const patches: Prefs[] = [];
    return {
      patches,
      store: {
        getPrefs: () => Promise.resolve(current),
        setPrefs: (patch) => {
          current = { ...current, ...patch };
          patches.push(current);
          return Promise.resolve(current);
        },
      },
    };
  };

  const makeSchedulerDeps = (store: JobPrefsStore): {
    store: JobPrefsStore;
    sink: JobShowSink;
    logger: { info: () => void; error: () => void };
  } => ({
    store,
    sink: { show: () => undefined, snooze: () => undefined },
    logger: { info: () => undefined, error: () => undefined },
  });

  it('(AC4) без согласия тик молчит: проверка не вызывается, сеть/журнал не трогаются (§5)', async () => {
    const consents: NetConsents = { updatesCheck: false, modelsDownload: false };
    const { store } = makeStore(consents);
    const check = vi.fn(() => Promise.resolve());
    const scheduler = new JobScheduler(makeSchedulerDeps(store));
    scheduler.register(createUpdatesCheckJob({ check }));

    await scheduler.tick(instantAt(T0));

    expect(check).not.toHaveBeenCalled();
  });

  it('(AC4) с согласием: первая проверка сразу, повтор — только через 24 ч (intervalMs, FixedClock-моменты)', async () => {
    const consents: NetConsents = { updatesCheck: true, modelsDownload: false };
    const { store, patches } = makeStore(consents);
    const check = vi.fn(() => Promise.resolve());
    const scheduler = new JobScheduler(makeSchedulerDeps(store));
    scheduler.register(createUpdatesCheckJob({ check }));

    await scheduler.tick(instantAt(T0));
    expect(check).toHaveBeenCalledTimes(1);

    await scheduler.tick(instantAt(T0 + DAY_MS - MINUTE_MS));
    expect(check).toHaveBeenCalledTimes(1); // окно 24 ч не истекло

    await scheduler.tick(instantAt(T0 + UPDATES_AUTO_CHECK_INTERVAL_MS));
    expect(check).toHaveBeenCalledTimes(2); // ровно на границе 24 ч (≥)
    expect(patches.at(-1)?.jobState?.jobs[UPDATES_CHECK_JOB_NAME]).toBe(
      T0 + UPDATES_AUTO_CHECK_INTERVAL_MS,
    );
  });

  it('отзыв согласия между тиками: следующий тик молчит (§3/§14)', async () => {
    const consents: NetConsents = { updatesCheck: true, modelsDownload: false };
    const { store } = makeStore(consents);
    const check = vi.fn(() => Promise.resolve());
    const scheduler = new JobScheduler(makeSchedulerDeps(store));
    scheduler.register(createUpdatesCheckJob({ check }));

    await scheduler.tick(instantAt(T0));
    consents.updatesCheck = false;
    await scheduler.tick(instantAt(T0 + UPDATES_AUTO_CHECK_INTERVAL_MS));

    expect(check).toHaveBeenCalledTimes(1);
  });
});
