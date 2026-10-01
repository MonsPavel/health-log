/**
 * TASK-096 §9/§19/§20: интеграционный тест боевой проводки UpdatesService —
 * контейнер собирает сервис над боевым EgressGateway (согласия из РЕАЛЬНОГО
 * PreferencesService), каналы updates/check|download|install зарегистрированы,
 * задача updates.check в реестре scheduler'а; адаптер updater'а подменён моком
 * (deps.updatesAdapter — §19, сеть в тестах не выполняется).
 *
 * Сценарии (приёмка §20):
 *  - updates/check без согласия → конверт отказа NET/BLOCKED_BY_POLICY, 0 вызовов
 *    адаптера, blocked-запись в журнале контейнера (AC1);
 *  - после prefs/set netConsents.updatesCheck=true → проверка проходит (конверт
 *    успеха), ok-запись журнала (AC2);
 *  - scheduler.tick: задача выполняет проверку при согласии и молчит без него
 *    (AC4 — проводка каркаса 074);
 *  - updates/install без скачанного → отказ UPD/NOT_READY (AC6).
 *
 * Хелперы (мок-vault, tmp-userData) повторяют container-egress.int.test.ts: импорт
 * тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ok, FixedClock, type AppError, type Result } from '@hl/kernel';

import { buildContainer } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';
import { UpdatesService, type UpdatesAdapter } from './modules/platform-services/updates/updates-service.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const FEED_URL = 'https://releases.example.com/latest';

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-updates-int-'));

class MockVault implements KeyVault {
  private ensured = 0;

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({
      ok: true,
      value: { keyHex: KEY_HEX, created: this.ensured++ === 0 },
    });
  }

  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return Promise.resolve({
      ok: false,
      error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY),
    });
  }

  setPassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  changePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  removePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  unlock(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  getMode(): 'none' {
    return 'none';
  }
}

/** Мок адаптера updater'а (§19): счётчики вызовов, исход — latest. */
class FakeAdapter implements UpdatesAdapter {
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;

  async getFeedUrl(): Promise<string> {
    return FEED_URL;
  }

  async checkForUpdates(): Promise<{ available: boolean }> {
    this.checkCalls += 1;
    return { available: false };
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
  }

  async quitAndInstall(): Promise<void> {
    this.installCalls += 1;
  }

  onAvailable(): void {
    /* события в этих сценариях не эмитятся */
  }

  onNotAvailable(): void {
    /* — */
  }

  onDownloadProgress(): void {
    /* — */
  }

  onDownloaded(): void {
    /* — */
  }

  onError(): void {
    /* — */
  }
}

describe('container + UpdatesService (TASK-096 §9/§19/§20)', () => {
  const dir = newUserDataDir();
  const adapter = new FakeAdapter();

  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container?.close();
    } catch {
      // закрыт самим сценарием — не важно для очистки
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates/check без согласия → конверт отказа NET/BLOCKED_BY_POLICY, 0 вызовов адаптера, blocked-запись журнала (AC1)', async () => {
    container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
      updatesAdapter: adapter,
    });

    expect(container.updates).toBeInstanceOf(UpdatesService);

    const envelope = await container.channels.dispatch({ channel: 'updates/check', payload: {} });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('NET/BLOCKED_BY_POLICY');
    }
    expect(adapter.checkCalls).toBe(0);
    const rows = container.db
      .prepare('SELECT kind, status FROM network_event')
      .all() as { kind: string; status: string }[];
    expect(rows).toEqual([{ kind: 'updates.check', status: 'blocked' }]);
  });

  it('после выдачи согласия prefs/set → проверка проходит конвертом успеха, журнал ok (AC2)', async () => {
    const grant = await container!.channels.dispatch({
      channel: 'prefs/set',
      payload: { patch: { netConsents: { updatesCheck: true, modelsDownload: false } } },
    });
    expect(grant.ok).toBe(true);

    const envelope = await container!.channels.dispatch({ channel: 'updates/check', payload: {} });

    expect(envelope).toMatchObject({ ok: true, data: { status: 'latest' } });
    expect(adapter.checkCalls).toBe(1);
    const rows = container!.db
      .prepare('SELECT kind, status FROM network_event ORDER BY at_utc, id')
      .all() as { kind: string; status: string }[];
    expect(rows).toEqual([
      { kind: 'updates.check', status: 'blocked' },
      { kind: 'updates.check', status: 'ok' },
    ]);
  });

  it('(AC4) scheduler.tick при согласии выполняет задачу updates.check (первый тик), повторный — молчит (24 ч)', async () => {
    // Адаптер общий на сценарий: до этого теста была 1 ручная проверка (канал).
    await container!.scheduler.tick({ utcMs: NOW_MS, tzOffsetMin: TZ });
    expect(adapter.checkCalls).toBe(2); // первая проверка задачи (lastRun не было)

    await container!.scheduler.tick({ utcMs: NOW_MS + 1, tzOffsetMin: TZ });
    expect(adapter.checkCalls).toBe(2); // интервал 24 ч не истёк — тик молчит
  });

  it('(AC6) updates/install без скачанного → конверт отказа UPD/NOT_READY; quitAndInstall не вызван', async () => {
    const envelope = await container!.channels.dispatch({ channel: 'updates/install', payload: {} });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('UPD/NOT_READY');
    }
    expect(adapter.installCalls).toBe(0);
  });
});
