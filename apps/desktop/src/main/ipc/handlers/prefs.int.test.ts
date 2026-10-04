// TASK-047 §11/§19/§20: интеграционный тест каналов `prefs/get|set` — полный путь
// «запрос → каркас (zod) → PreferencesService → SettingsStore → шифрованная SQLite»
// через контейнер (прецедент search.int.test.ts TASK-045). Матрица:
//  1. prefs/get на свежем контейнере → DEFAULT_PREFS (§8; AC «пусто — дефолты»);
//  2. prefs/set {theme:'dark'} → ответ — обновлённый ПОЛНЫЙ документ; prefs/get
//     после set → dark; ПЕРЕЗАПУСК контейнера (close → build на том же userData)
//     → тема dark — персистентность в БД (§20 AC2);
//  3. неизвестное поле patch → отброшено, валидные применены (§20 AC5): ответ и
//     повторное чтение без «мусорного» поля;
//  4. невалидный patch (тема числом) → VALIDATION/FAILED каркаса (§11);
//  5. повреждённый value_json в БД (внесён напрямую SQL) → prefs/get → дефолты,
//     без ошибки (§20 AC3);
//  6. событие prefs:changed публикуется на шине контейнера с patchKeys.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PREFS_GET_RESPONSE_SCHEMA, PREFS_SET_RESPONSE_SCHEMA } from '@hl/contracts';
import { AppError, FixedClock, type Result, ok } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';
import { DEFAULT_PREFS } from '../../modules/settings-profile/application/preferences-service.js';

/** Фиксированный тестовый ключ мок-vault (§19). */
const KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» FixedClock. */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Свежий tmp-userData; удаление — в конце кейса (§14). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-prefs-int-'));

/** Мок-vault (§19): фиксированный ключ без safeStorage. */
class MockVault implements KeyVault {
  private ensured = 0;

  /** TASK-121 §3: импорт ключа из копии — мок-заглушка (сценарий восстановление не зовёт). */
  importKey(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

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

  // TASK-093 §5/§7: парольные режимы в этом сценарии не используются — нейтральные
  // заглушки контракта (сессия всегда разблокирована, mode='none').
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

const makeContainer = async (dir: string) =>
  buildContainer({
    userDataPath: dir,
    clock: new FixedClock(NOW_MS, TZ),
    vault: () => new MockVault(),
  });

describe('prefs/get|set через контейнер — полный путь (TASK-047 §20)', () => {
  it('(1) prefs/get на свежем контейнере → дефолты (§8)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await container.channels.dispatch({ channel: 'prefs/get', payload: {} });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      expect(PREFS_GET_RESPONSE_SCHEMA.parse(envelope.data)).toEqual(DEFAULT_PREFS);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(2) set theme=dark → get → dark; перезапуск контейнера → тема сохранилась в БД (AC2)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    let rebuilt: Awaited<ReturnType<typeof makeContainer>> | undefined;
    try {
      const setEnvelope = await container.channels.dispatch({
        channel: 'prefs/set',
        payload: { patch: { theme: 'dark', textScale: '112.5' } },
      });
      expect(setEnvelope).toMatchObject({ ok: true });
      if (!setEnvelope.ok) {
        return;
      }
      // Ответ set — обновлённый ПОЛНЫЙ документ (§11).
      expect(PREFS_SET_RESPONSE_SCHEMA.parse(setEnvelope.data)).toEqual({
        ...DEFAULT_PREFS,
        theme: 'dark',
        textScale: '112.5',
      });

      const got = await container.channels.dispatch({ channel: 'prefs/get', payload: {} });
      if (!got.ok) {
        return;
      }
      expect(PREFS_GET_RESPONSE_SCHEMA.parse(got.data).theme).toBe('dark');

      // «Перезапуск»: закрыли (WAL-чекпоинт + close) и собрали контейнер заново
      // на том же userData — настройки читаются из БД.
      container.close();
      rebuilt = await makeContainer(dir);
      const afterRestart = await rebuilt.channels.dispatch({ channel: 'prefs/get', payload: {} });
      expect(afterRestart).toMatchObject({ ok: true });
      if (!afterRestart.ok) {
        return;
      }
      expect(PREFS_GET_RESPONSE_SCHEMA.parse(afterRestart.data)).toEqual({
        ...DEFAULT_PREFS,
        theme: 'dark',
        textScale: '112.5',
      });
    } finally {
      rebuilt?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) неизвестное поле patch → отброшено, валидные применены (AC5)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const setEnvelope = await container.channels.dispatch({
        channel: 'prefs/set',
        payload: { patch: { theme: 'dark', hackerField: true } },
      });
      expect(setEnvelope).toMatchObject({ ok: true });
      if (!setEnvelope.ok) {
        return;
      }
      const parsed = PREFS_SET_RESPONSE_SCHEMA.parse(setEnvelope.data);
      expect(parsed.theme).toBe('dark');
      expect(parsed).not.toHaveProperty('hackerField');
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) невалидный patch (тема числом) → VALIDATION/FAILED (§11)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await container.channels.dispatch({
        channel: 'prefs/set',
        payload: { patch: { theme: 123 } },
      });
      expect(envelope).toMatchObject({ ok: false });
      if (envelope.ok) {
        return;
      }
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) повреждённый value_json в БД → prefs/get вернул дефолты, без ошибки (AC3)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      container.db
        .prepare("UPDATE app_setting SET value_json = '{not json' WHERE key = 'prefs'")
        .run();

      const envelope = await container.channels.dispatch({ channel: 'prefs/get', payload: {} });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      expect(PREFS_GET_RESPONSE_SCHEMA.parse(envelope.data)).toEqual(DEFAULT_PREFS);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6) set публикует prefs:changed {patchKeys} на шине контейнера (§5)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const events: { name: string; payload: unknown }[] = [];
      container.events.on('prefs:changed', (payload) => {
        events.push({ name: 'prefs:changed', payload });
      });

      await container.channels.dispatch({
        channel: 'prefs/set',
        payload: { patch: { dateFormat: 'mdy' } },
      });

      expect(events).toEqual([{ name: 'prefs:changed', payload: { patchKeys: ['dateFormat'] } }]);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
