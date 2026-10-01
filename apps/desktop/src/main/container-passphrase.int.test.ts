/**
 * TASK-093 §9/§19/§20: интеграционный тест контейнера в режиме passphrase —
 * ленивое открытие БД (изменение контейнера 027, включено в объём §5):
 *  - сборка на vault-файле mode=passphrase УСПЕШНА и НЕ открывает БД (файла БД нет);
 *  - доступ к container.db до unlock → синхронный VAULT/LOCKED (прокси §9);
 *  - unlock(неверный) → VAULT/WRONG_PASSPHRASE — БД по-прежнему не открыта
 *    (§20: верификация пароля по GCM-tag без открытия БД);
 *  - unlock(верный) → openDatabase() → БД открыта, миграции применены
 *    (schema_version = максимум реестра), выборка читается;
 *  - смена пароля не перешифровывает БД (§20): данные читаются после
 *    changePassphrase в той же сессии и в НОВОЙ сессии под новым паролем;
 *    старый пароль больше не открывает;
 *  - mode=none не регрессировал: сборка с мок-vault (getMode()='none') открывает
 *    БД сразу, openDatabase() — ok немедленно (контроль прецедента TASK-027).
 *
 * Vault — боевой SafeStorageKeyVault над моком safeStorage (§19) с быстрой
 * калибровкой (8 МБ × 1 итерация — миллисекунды); tmp-userData, послеAll — очистка.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, ok, unsafeUnwrap, type Clock, type Result } from '@hl/kernel';

import { buildContainer, DATABASE_FILENAME } from './container.js';
import { VAULT_KEY_FILENAME } from './shared/constants.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';
import type { Argon2Params } from './modules/security/adapters/passphrase-crypto.js';
import {
  SafeStorageKeyVault,
  type VaultLogger,
  type VaultSafeStorage,
} from './modules/security/adapters/safe-storage-key-vault.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

/** Пароль сценария и быстрые параметры калибровки (§19: миллисекунды). */
const PASS = 'пароль-контейнера-093';
const NEW_PASS = 'новый-пароль-контейнера';
const FAST_PARAMS: Argon2Params = { iterations: 1, memoryKib: 8192, parallelism: 1 };

/** Фиксированное «сейчас» FixedClock — как в контрактных наборах. */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Свежий tmp-userData (каталог БД и vault.key). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-pass-'));

/** Мок safeStorage — симметричный «шифр» с префиксом (§19, прецедент TASK-023). */
class FakeSafeStorage implements VaultSafeStorage {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`hl-vault-test:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('hl-vault-test:')) {
      return 'расшифрованный-мусор-не-ключ';
    }
    return text.slice('hl-vault-test:'.length);
  }
}

const silentLogger: VaultLogger = { info: () => undefined, warn: () => undefined };

/**
 * Боевой vault-адаптер над моком safeStorage (§19): passphrase-механика реальная
 * (Argon2id + GCM), быстрая калибровка; путь файла — из контекста контейнера.
 */
const makeRealVaultFactory =
  () => (context: { vaultFilePath: string; clock: Clock; logger: VaultLogger }) =>
    new SafeStorageKeyVault({
      vaultFilePath: context.vaultFilePath,
      safeStorage: new FakeSafeStorage(),
      clock: context.clock,
      logger: context.logger,
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });

/** Готовит tmp-userData с vault-файлом mode=passphrase (пароль включён заранее). */
const setupPassphraseUserData = async (dir: string): Promise<void> => {
  const vault = new SafeStorageKeyVault({
    vaultFilePath: join(dir, VAULT_KEY_FILENAME),
    safeStorage: new FakeSafeStorage(),
    clock: new FixedClock(NOW_MS, TZ),
    logger: silentLogger,
    calibrate: () => Promise.resolve(FAST_PARAMS),
  });
  unsafeUnwrap(await vault.ensureKey(false));
  unsafeUnwrap(await vault.setPassphrase(PASS));
};

/** deps сборки: реальный vault-адаптер над моком safeStorage (§19). */
const makePassphraseDeps = (dir: string) => ({
  userDataPath: dir,
  clock: new FixedClock(NOW_MS, TZ),
  vault: makeRealVaultFactory(),
});

/** Мок-vault TASK-027 (контроль mode=none): без safeStorage, getMode()='none'. */
class MockVault implements KeyVault {
  private ensured = 0;

  constructor(private readonly keyHex: string) {}

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({
      ok: true,
      value: { keyHex: this.keyHex, created: this.ensured++ === 0 },
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

  getMode(): 'none' {
    return 'none';
  }
}

describe('buildContainer — режим passphrase (TASK-093 §9: ленивое открытие БД)', () => {
  const dirs: string[] = [];
  const containers: { close(): void }[] = [];

  afterAll(() => {
    for (const container of containers) {
      try {
        container.close();
      } catch {
        // закрыт самим сценарием — не важно для очистки
      }
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const track = <T extends { close(): void }>(container: T): T => {
    containers.push(container);
    return container;
  };

  it('1. сборка при mode=passphrase: БД НЕ открыта; доступ к db → VAULT/LOCKED; openDatabase → LOCKED (§9)', async () => {
    const dir = newUserDataDir();
    dirs.push(dir);
    await setupPassphraseUserData(dir);
    expect(existsSync(join(dir, VAULT_KEY_FILENAME))).toBe(true);
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);

    // Сборка успешна — приложение стартует в состоянии locked (§9/§12).
    const container = track(await buildContainer(makePassphraseDeps(dir)));
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);

    // Доступ к данным до unlock — синхронный VAULT/LOCKED (прокси §9: конструкторы
    // графа получают ленивые placeholder-statement'ы, реальное чтение — LOCKED).
    let caught: unknown;
    try {
      container.db.prepare('SELECT 1').get();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VAULT/LOCKED');
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);

    // openDatabase до unlock — err VAULT/LOCKED, БД не создана.
    const openResult = await container.openDatabase();
    expect(openResult.ok).toBe(false);
    if (!openResult.ok) {
      expect(openResult.error.code).toBe('VAULT/LOCKED');
    }
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);
  });

  it('2. unlock: неверный пароль → WRONG_PASSPHRASE, БД не открыта; верный → openDatabase открывает (миграции, чтение) (§19/§20)', async () => {
    const dir = newUserDataDir();
    dirs.push(dir);
    await setupPassphraseUserData(dir);
    const container = track(await buildContainer(makePassphraseDeps(dir)));

    // Неверный пароль: детект по GCM-tag — БД не открывалась (§20).
    const wrong = await container.vault.unlock('неверный-пароль');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.code).toBe('VAULT/WRONG_PASSPHRASE');
    }
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);
    expect((await container.openDatabase()).ok).toBe(false);

    // Верный пароль: unlock → ensureKey → открытие БД (§9).
    expect((await container.vault.unlock(PASS)).ok).toBe(true);
    const opened = await container.openDatabase();
    expect(opened.ok).toBe(true);
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);

    // Миграции применены, выборка через прокси работает (§9: БД открыта по требованию).
    const version = container.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(MIGRATIONS.at(-1)?.version));
    const count = container.db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as {
      n: number;
    };
    expect(count.n).toBe(0);

    // Идемпотентность: повторный openDatabase — ok.
    expect((await container.openDatabase()).ok).toBe(true);
  });

  it('3. смена пароля не перешифровывает БД: данные читаются в сессии и в новой сессии под новым паролем; старый не открывает (§13/§20)', async () => {
    const dir = newUserDataDir();
    dirs.push(dir);
    await setupPassphraseUserData(dir);

    // Сессия 1: unlock → открытие → запись данных.
    const session1 = track(await buildContainer(makePassphraseDeps(dir)));
    expect((await session1.vault.unlock(PASS)).ok).toBe(true);
    expect((await session1.openDatabase()).ok).toBe(true);
    session1.db
      .prepare(
        "INSERT INTO bp_measurement (id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) VALUES ('m-093', 'seed-profile-0001', 1758816000000, 180, 120, 80, NULL, 0, 'left', NULL, 'manual', 1758816000000, 1758816000000)",
      )
      .run();

    // Смена пароля: переобёртка файла, БД (соединение) не перешифровывается.
    expect((await session1.vault.changePassphrase(PASS, NEW_PASS)).ok).toBe(true);
    // Данные читаются тем же соединением (инвариант §7: dbKey не менялся).
    const countSame = session1.db
      .prepare('SELECT count(*) AS n FROM bp_measurement WHERE id = ?')
      .get('m-093') as { n: number };
    expect(countSame.n).toBe(1);
    session1.close();

    // Сессия 2 (новый старт): новый пароль открывает, старый — нет; данные на месте.
    const session2 = track(await buildContainer(makePassphraseDeps(dir)));
    const oldPass = await session2.vault.unlock(PASS);
    expect(oldPass.ok).toBe(false);
    if (!oldPass.ok) {
      expect(oldPass.error.code).toBe('VAULT/WRONG_PASSPHRASE');
    }
    expect((await session2.vault.unlock(NEW_PASS)).ok).toBe(true);
    expect((await session2.openDatabase()).ok).toBe(true);
    const countNew = session2.db
      .prepare('SELECT count(*) AS n FROM bp_measurement WHERE id = ?')
      .get('m-093') as { n: number };
    expect(countNew.n).toBe(1);
  });

  it('4. mode=none не регрессировал: БД открыта при сборке, openDatabase — ok немедленно (контроль TASK-027)', async () => {
    const dir = newUserDataDir();
    dirs.push(dir);
    const container = track(
      await buildContainer({
        userDataPath: dir,
        clock: new FixedClock(NOW_MS, TZ),
        vault: () => new MockVault('ab'.repeat(32)),
      }),
    );

    // Eager-старт: БД открыта при сборке, миграции применены.
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);
    const version = container.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(MIGRATIONS.at(-1)?.version));
    expect((await container.openDatabase()).ok).toBe(true);
  });
});
