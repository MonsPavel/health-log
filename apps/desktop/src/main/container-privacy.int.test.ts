/**
 * TASK-098 §9/§19/§20: интеграционный тест боевой проводки PrivacyQueries —
 * контейнер собирает запросы над боевым EgressGateway (журнал network_event) и
 * РЕАЛЬНЫМ PreferencesService (согласия); каналы privacy/journal|consents
 * зарегистрированы и доступны через dispatch каркаса. Адаптер updater'а подменён
 * моком (deps.updatesAdapter — §19): сеть не выполняется, записи журнала создаются
 * РЕАЛЬНЫМ gateway — мок-операции gateway-тестов 075 переиспользуются (§19).
 *
 * Сценарии (приёмка §20):
 *  - privacy/journal на чистой сборке: entries [], ops == политике (2, enabled false) — AC2;
 *  - updates/check без согласия → blocked-запись журнала; privacy/journal {limit}:
 *    desc по at_utc, лимит, поля DTO полные — AC1;
 *  - privacy/consents: чтение {}; patch известным ключом применяется (и персистентен
 *    в prefs), ops.enabled отражает; неизвестный ключ — конверт VALIDATION/FAILED
 *    ДО хендлера — AC3/§14 (согласия меняются только этим каналом);
 *  - после выдачи согласия updates/check проходит → ok-запись, лента desc — живой
 *    журнал (инвалидация рендерера по net:activity — тест хука 098).
 *
 * Хелперы (мок-vault, tmp-userData, FakeAdapter) повторяют container-updates.int.test.ts:
 * импорт тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, ok, type Clock, type Result } from '@hl/kernel';

import type { ChannelName, Consents, PrivacyJournalResponse } from '@hl/contracts';

import { buildContainer } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';
import type { UpdatesAdapter } from './modules/platform-services/updates/updates-service.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const FEED_URL = 'https://releases.example.com/latest';

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-privacy-int-'));

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

  // TASK-094 §5: сброс сессии в mode=none — no-op (мок; см. порт key-vault).
  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

/** Мок адаптера updater'а (§19): исход latest, сеть не выполняется. */
class FakeAdapter implements UpdatesAdapter {
  checkCalls = 0;

  getFeedUrl(): Promise<string> {
    return Promise.resolve(FEED_URL);
  }

  checkForUpdates(): Promise<{ available: boolean }> {
    this.checkCalls += 1;
    return Promise.resolve({ available: false });
  }

  downloadUpdate(): Promise<void> {
    return Promise.resolve();
  }

  quitAndInstall(): Promise<void> {
    return Promise.resolve();
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

describe('container + PrivacyQueries (TASK-098 §9/§19/§20)', () => {
  const dir = newUserDataDir();
  const adapter = new FakeAdapter();
  /** Шагающие часы: детерминированный порядок at_utc для desc-проверки ленты. */
  let now = NOW_MS;
  const clock: Clock = { nowMs: () => (now += 1000), tzOffsetMin: () => TZ };

  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container?.close();
    } catch {
      // закрыт самим сценарием — не важно для очистки
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Конверт успеха с типизированными данными (dispatch — ApiEnvelope<unknown>). */
  const okData = async <T>(channel: ChannelName, payload: unknown): Promise<T> => {
    const envelope = await container!.channels.dispatch({ channel, payload });
    if (!envelope.ok) {
      throw new Error(`ожидался конверт успеха канала ${channel}`);
    }
    return envelope.data as T;
  };

  it('privacy/journal на чистой сборке: entries [], ops == политике (инвариант AC2), enabled из дефолтных согласий (false)', async () => {
    container = await buildContainer({
      userDataPath: dir,
      clock,
      vault: () => new MockVault(),
      updatesAdapter: adapter,
    });

    const journal = await okData<PrivacyJournalResponse>('privacy/journal', {});

    expect(journal.entries).toEqual([]);
    expect(journal.ops).toEqual([
      {
        op: 'models.download',
        consentKey: 'modelsDownload',
        descriptionKey: 'privacy.ops.models_download',
        enabled: false,
      },
      {
        op: 'updates.check',
        consentKey: 'updatesCheck',
        descriptionKey: 'privacy.ops.updates_check',
        enabled: false,
      },
    ]);
  });

  it('blocked-мок-операция 075 видна в канале: desc, лимит, поля DTO полные (AC1)', async () => {
    // updates/check без согласия → отказ согласия/политики gateway'ем, blocked-запись.
    const check = await container!.channels.dispatch({ channel: 'updates/check', payload: {} });
    expect(check.ok).toBe(false);

    const journal = await okData<PrivacyJournalResponse>('privacy/journal', { limit: 5 });

    expect(journal.entries).toHaveLength(1);
    const blocked = journal.entries[0]!;
    expect(blocked).toEqual({
      kind: 'updates.check',
      endpoint: '', // отказ checkPermission: адрес не наблюдаем gateway'ем (§22 096)
      status: 'blocked',
      atUtc: expect.any(Number),
    });
    expect(blocked.bytes).toBeUndefined(); // NULL журнала → поле отсутствует (§5)
  });

  it('privacy/consents: patch известным ключом применяется и персистентен; ops.enabled отражает; ok-запись сети (AC3/§14)', async () => {
    const patched = await okData<Consents>('privacy/consents', { patch: { updatesCheck: true } });
    expect(patched).toEqual({ updatesCheck: true, modelsDownload: false });

    // Персистентность: повторное чтение — из prefs (реальный PreferencesService).
    const readBack = await okData<Consents>('privacy/consents', {});
    expect(readBack).toEqual({ updatesCheck: true, modelsDownload: false });

    // Согласие, выданное каналом, мгновенно действует: проверка проходит, ok-запись.
    const check = await container!.channels.dispatch({ channel: 'updates/check', payload: {} });
    expect(check).toMatchObject({ ok: true, data: { status: 'latest' } });
    expect(adapter.checkCalls).toBe(1);

    const journal = await okData<PrivacyJournalResponse>('privacy/journal', { limit: 1 });

    // desc (AC1): лимит 1 — только САМАЯ новая запись (ok, позже blocked).
    expect(journal.entries).toEqual([
      {
        kind: 'updates.check',
        endpoint: FEED_URL,
        status: 'ok',
        atUtc: expect.any(Number),
      },
    ]);
    // enabled операций отражает текущие согласия.
    expect(journal.ops).toEqual([
      expect.objectContaining({ op: 'models.download', enabled: false }),
      expect.objectContaining({ op: 'updates.check', enabled: true }),
    ]);
  });

  it('privacy/consents: неизвестный ключ patch → конверт VALIDATION/FAILED, prefs не изменены (§5/§14)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'privacy/consents',
      payload: { patch: { unknownKey: true } },
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
    }
    const readBack = await okData<Consents>('privacy/consents', {});
    expect(readBack).toEqual({ updatesCheck: true, modelsDownload: false });
  });
});
