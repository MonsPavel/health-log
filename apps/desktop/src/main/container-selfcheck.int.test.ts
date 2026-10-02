/**
 * TASK-100 §9/§15/§19/§20: интеграционные тесты контейнера с сампроверкой старта.
 *
 *  - healthy-старт (tmp-userData, реальные миграции): отчёт ПОЛНЫЙ — dbOk=true,
 *    schemaVersion = максимум реестра, vaultMode, worker, prefsOk; ≤150 мс (замер
 *    §15/AC1 — системные часы, не FixedClock); отчёт без путей (AC5);
 *  - повреждённая БД (байт-флип первого байта последней b-tree страницы фикстуры):
 *    контейнер ПРОДОЛЖАЕТ старт (не throw — «обнаружить» отделено от «реагировать»,
 *    §9/AC2: заглушка recovery 101 — здесь только флаг dbOk=false), остальной отчёт
 *    заполнен (частичная диагностика §13);
 *  - старт в режиме passphrase: самчек выполняется в openDatabase (после миграций
 *    и активации шкалы) — до unlock отчёта нет (null в канале app/selfcheck).
 *
 * Vault — мок mode=none (§19, прецедент container-passphrase.int.test.ts); время —
 * системное (замер §15 честный). Повреждение — в КОНТЕЙНЕРНОЙ БД (не обёртки):
 * поведение openEncrypted при quick_check≠'ok' меняется этой задачей — повреждённая
 * БД остаётся открытой (§9), соединение не закрывается до проброса.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, ok, unsafeUnwrap, type Result } from '@hl/kernel';

import { buildContainer, DATABASE_FILENAME, type Container } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';
import {
  SafeStorageKeyVault,
  type VaultLogger,
  type VaultSafeStorage,
} from './modules/security/adapters/safe-storage-key-vault.js';
import { VAULT_KEY_FILENAME } from './shared/constants.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';

/** Ключ фикстуры (мок-vault отдаёт его всегда) и пароль passphrase-сценария. */
const KEY_HEX = 'b'.repeat(64);
const PASS = 'пароль-самчека-100';

/** Свежий tmp-userData. */
const dirs: string[] = [];
const newUserDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-container-selfcheck-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  // Сначала закрываем соединения (Windows: открытый дескриптор держит файл —
  // прецедент очистки container-passphrase.int.test.ts), затем удаляем каталоги.
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

/** Мок-vault mode=none (§19): фиксированный ключ, без safeStorage. */
class MockVault implements KeyVault {
  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({ ok: true, value: { keyHex: KEY_HEX, created: false } });
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

  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

/** Мок safeStorage — симметричный «шифр» с префиксом (прецедент 093). */
class FakeSafeStorage implements VaultSafeStorage {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`hl-selfcheck-test:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('hl-selfcheck-test:')) {
      return 'расшифрованный-мусор-не-ключ';
    }
    return text.slice('hl-selfcheck-test:'.length);
  }
}

/** Быстрая калибровка Argon2 (§19: миллисекунды). */
const FAST_PARAMS = { iterations: 1, memoryKib: 8192, parallelism: 1 };

const silentVaultLogger: VaultLogger = { info: () => undefined, warn: () => undefined };

const deps = (dir: string) => ({
  userDataPath: dir,
  // Системные часы: замер startupMs §15/AC1 должен быть честным (не 0 FixedClock).
  vault: () => new MockVault(),
});

const containers: Container[] = [];

/** Флип первого байта последней страницы (page-type byte b-tree листа). */
function corruptLastPage(file: string, pageSize: number): void {
  const bytes = readFileSync(file);
  expect(bytes.length % pageSize).toBe(0);
  bytes[bytes.length - pageSize] = 0x00;
  writeFileSync(file, bytes);
}

describe('buildContainer — сампроверка старта (TASK-100 §19/§20)', () => {
  it('healthy-старт: отчёт полный, ≤150 мс (замер §15), без путей (AC1/AC5)', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer(deps(dir));
    containers.push(container);

    const report = container.selfcheck.report;
    expect(report).toBeDefined();
    expect(report?.dbOk).toBe(true);
    expect(report?.schemaVersion).toBe(MIGRATIONS.at(-1)?.version ?? 0);
    expect(report?.vaultMode).toBe('none');
    expect(report?.worker).toBeDefined(); // ИИ-модуль в графе — статус присутствует
    expect(report?.worker?.state).toBe('starting'); // spawn ленивый — ещё не спавнился
    expect(report?.prefsOk).toBe(true);
    expect(typeof report?.checkedAtUtc).toBe('number');
    // Замер §15/AC1: самчек ≤150 мс общего старта (системные часы).
    expect(report?.startupMs).toBeLessThanOrEqual(150);
    // AC5: отчёт не содержит путей (userData с именем пользователя — §14).
    expect(JSON.stringify(report)).not.toContain(dir);
    expect(JSON.stringify(report)).not.toContain(DATABASE_FILENAME);
  });

  it('повреждённая БД: контейнер стартует, dbOk=false, остальной отчёт заполнен (AC2, §9)', async () => {
    const dir = newUserDataDir();
    // Старт №1: создать БД (миграции) и наполнить многостраничной таблицей —
    // последняя страница файла станет leaf этой таблицы (meta/шкалы/prefs —
    // ранние страницы, остаются целыми: частичная диагностика §13).
    const first = await buildContainer(deps(dir));
    first.db.exec('CREATE TABLE smoke_big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const insert = first.db.prepare('INSERT INTO smoke_big (v) VALUES (?)');
    first.db.transaction((rows: number) => {
      for (let i = 0; i < rows; i += 1) {
        insert.run(`row-${i}-payload-padding`);
      }
    })(400);
    const pageSize = first.db.pragma('page_size', { simple: true }) as number;
    first.close();

    // Повреждение ПОСЛЕ закрытия (WAL вчекпоинчен в главный файл).
    const file = join(dir, DATABASE_FILENAME);
    corruptLastPage(file, pageSize);

    // Старт №2: buildContainer НЕ бросает — обнаружение отделено от реакции (§9).
    const second = await buildContainer(deps(dir));
    containers.push(second);

    const report = second.selfcheck.report;
    expect(report).toBeDefined();
    expect(report?.dbOk).toBe(false);
    // Частичная диагностика (§13): версии/режим/prefs заполнены фактами.
    expect(report?.schemaVersion).toBe(MIGRATIONS.at(-1)?.version ?? 0);
    expect(report?.vaultMode).toBe('none');
    expect(report?.prefsOk).toBe(true);
    expect(typeof report?.checkedAtUtc).toBe('number');
    // TASK-101 §4/§5: dbOk=false → recovery-режим — реакция отделилась от
    // обнаружения: соединение ЗАКРЫТО (доступ через прокси — VAULT/LOCKED),
    // контекст для RecoveryScreen собран (reason corrupt, quick_check в деталях).
    expect(second.recovery?.reason).toBe('corrupt');
    expect(second.recovery?.details.quickCheck).toBeDefined();
    expect(() => second.db.prepare('SELECT count(*) AS n FROM meta').get()).toThrow();
  });

  it('passphrase-старт: до unlock отчёта нет; openDatabase выполняет самчек после миграций', async () => {
    const dir = newUserDataDir();
    const vaultFilePath = join(dir, VAULT_KEY_FILENAME);
    // Готовим vault mode=passphrase заранее (пароль включён — §19 прецедент 093).
    const setup = new SafeStorageKeyVault({
      vaultFilePath,
      safeStorage: new FakeSafeStorage(),
      clock: { nowMs: () => 0, tzOffsetMin: () => 0 },
      logger: silentVaultLogger,
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });
    unsafeUnwrap(await setup.ensureKey(false));
    unsafeUnwrap(await setup.setPassphrase(PASS));

    const container = await buildContainer({
      userDataPath: dir,
      vault: (context) =>
        new SafeStorageKeyVault({
          vaultFilePath: context.vaultFilePath,
          safeStorage: new FakeSafeStorage(),
          clock: context.clock,
          logger: context.logger,
          calibrate: () => Promise.resolve(FAST_PARAMS),
        }),
    });
    containers.push(container);

    // До unlock БД не открыта и самчек не выполнялся (канал вернёт null, §11).
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);
    expect(container.selfcheck.report).toBeUndefined();

    // Полный путь 094: unlock (проверка пароля портом 093) → openDatabase (§9).
    const unlocked = await container.vaultService.unlock(PASS);
    expect(unlocked.ok).toBe(true);
    const opened = await container.openDatabase();
    expect(opened.ok).toBe(true);
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);

    const report = container.selfcheck.report;
    expect(report).toBeDefined();
    expect(report?.vaultMode).toBe('passphrase');
    expect(report?.dbOk).toBe(true);
    expect(report?.schemaVersion).toBe(MIGRATIONS.at(-1)?.version ?? 0);
  });
});
