/**
 * TASK-101 §9/§19/§20: интеграционные тесты контейнера в recovery-режиме.
 *
 * Матрица:
 *  1. corrupt-фикстура (байт-флип последней страницы, прецедент TASK-100): buildContainer
 *     НЕ бросает — контейнер стартует в recovery: контекст {reason: 'corrupt',
 *     details.quickCheck ≠ 'ok'}; БД закрыта (доступ к db — VAULT/LOCKED); канал
 *     app/meta отдаёт recovery-контекст (scale/model опущены — БД-чтений нет, §7/§9);
 *  2. MIGRATION_FAILED-ветка (фикстура-миграция с ошибкой v8, TEST-ONLY deps.migrations):
 *     тот же recovery-режим, reason 'migration_failed', migrationVersion в деталях (§20 AC5);
 *  3. инвентарь-тест (§5/§14): В SE происхождения — ЛЮБОЙ secure-канал реестра вне
 *     разрешённого набора → STORAGE/RECOVERY_MODE; разрешённые (backup/restore,
 *     data/discard-db) проходят гвардию дальше (валидация payload → VALIDATION/FAILED);
 *  4. healthy-старт: recovery нет, app/meta без recovery-поля (регрессия);
 *  5. healthy: data/discard-db НЕ зарегистрирован (APP/INTERNAL); recovery-вариант
 *     backup/restore в здоровом режиме отклонён (VALIDATION/FAILED — misuse-гвардия);
 *  6. passphrase-режим с повреждённой БД: unlock проходит (пароль верен), openDatabase
 *     вводит recovery — тот же экран после входа (§5 «ветка dbOk=false»).
 *
 * Vault — мок mode=none (§19, прецедент container-selfcheck.int.test.ts); passphrase-
 * сценарий — SafeStorageKeyVault с FakeSafeStorage (§19 093/100).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { API_ENVELOPE_VERSION, CHANNEL_SCHEMAS } from '@hl/contracts';
import type { RecoveryContext } from '@hl/contracts';
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
import type { Migration } from './shared/db/migration-runner.js';

/** Ключ фикстуры (мок-vault отдаёт его всегда) и пароль passphrase-сценария. */
const KEY_HEX = 'c'.repeat(64);
const PASS = 'пароль-recovery-101';

/** Свежий tmp-userData. */
const dirs: string[] = [];
const containers: Container[] = [];
const newUserDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-container-recovery-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  // Сначала закрываем соединения (Windows: открытый дескриптор держит файл),
  // затем удаляем каталоги (прецедент container-selfcheck.int.test.ts).
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
  /** TASK-121 §3: импорт ключа из копии — мок-заглушка (сценарий восстановление не зовёт). */
  importKey(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

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

/** Мок safeStorage — симметричный «шифр» с префиксом (прецедент 093/100). */
class FakeSafeStorage implements VaultSafeStorage {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`hl-recovery-test:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('hl-recovery-test:')) {
      return 'расшифрованный-мусор-не-ключ';
    }
    return text.slice('hl-recovery-test:'.length);
  }
}

/** Быстрая калибровка Argon2 (§19: миллисекунды). */
const FAST_PARAMS = { iterations: 1, memoryKib: 8192, parallelism: 1 };

const silentVaultLogger: VaultLogger = { info: () => undefined, warn: () => undefined };

/** Флип первого байта последней страницы (page-type byte b-tree листа, §19 100). */
function corruptLastPage(file: string, pageSize: number): void {
  const bytes = readFileSync(file);
  expect(bytes.length % pageSize).toBe(0);
  bytes[bytes.length - pageSize] = 0x00;
  writeFileSync(file, bytes);
}

/** Диспетчер каналов контейнера с ожиданием ok-конверта (иначе — ошибка сценария). */
async function dispatchOk(
  container: Container,
  channel: string,
  payload: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string } }> {
  const envelope = await container.channels.dispatch({ channel, payload });
  expect(envelope.v).toBe(API_ENVELOPE_VERSION);
  if (envelope.ok) {
    return { ok: true, data: envelope.data };
  }
  return { ok: false, error: { code: envelope.error.code } };
}

describe('buildContainer — corrupt-фикстура → recovery-режим (TASK-101 §9/§20 AC1)', () => {
  it('старт не падает: контекст corrupt с quick_check, БД закрыта, app/meta несёт recovery', async () => {
    const dir = newUserDataDir();
    // Старт №1: создать БД и наполнить многостраничной таблицей — последняя страница
    // файла станет leaf этой таблицы (meta/шкалы — ранние страницы, прецедент 100).
    const first = await buildContainer({ userDataPath: dir, vault: () => new MockVault() });
    containers.push(first);
    first.db.exec('CREATE TABLE smoke_big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const insert = first.db.prepare('INSERT INTO smoke_big (v) VALUES (?)');
    first.db.transaction((rows: number) => {
      for (let i = 0; i < rows; i += 1) {
        insert.run(`row-${i}-payload-padding`);
      }
    })(400);
    const pageSize = first.db.pragma('page_size', { simple: true }) as number;
    first.close();

    corruptLastPage(join(dir, DATABASE_FILENAME), pageSize);

    // Старт №2: buildContainer НЕ бросает — контейнер в recovery (§5 «ветка dbOk=false»).
    const second = await buildContainer({ userDataPath: dir, vault: () => new MockVault() });
    containers.push(second);

    const recovery: RecoveryContext | undefined = second.recovery;
    expect(recovery).toBeDefined();
    expect(recovery?.reason).toBe('corrupt');
    // Детали для раскрытия (§5/§7): вывод quick_check — служебные строки SQLite, не 'ok'.
    expect(recovery?.details.quickCheck).toBeDefined();
    expect(recovery?.details.quickCheck).not.toBe('ok');

    // БД закрыта (§4: «приложение стартует БЕЗ рабочего контейнера») — доступ к db
    // через прокси даёт LOCKED при ИСПОЛЬЗОВАНИИ statement (prepare ленив — контракт
    // прокси §9 093/094; компиляция — при первом обращении к закрытому соединению).
    expect(() => second.db.prepare('SELECT 1').get()).toThrow();

    // app/meta (§10: гейт App проверяет режим этим каналом): recovery-контекст,
    // scale/model опущены (БД-чтений нет).
    const meta = await dispatchOk(second, 'app/meta', {});
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      const data = meta.data as Record<string, unknown>;
      expect(data['appVersion']).toBe('0.0.0');
      expect(data['scale']).toBeUndefined();
      expect(data['model']).toBeUndefined();
      const recoveryData = data['recovery'] as Record<string, unknown> | undefined;
      expect(recoveryData).toBeDefined();
      expect(recoveryData?.['reason']).toBe('corrupt');
    }

    // app/selfcheck: снимок старта с dbOk=false (обнаружение — TASK-100, реакция — 101).
    const selfcheck = await dispatchOk(second, 'app/selfcheck', {});
    expect(selfcheck.ok).toBe(true);
    if (selfcheck.ok) {
      expect((selfcheck.data as { dbOk: boolean }).dbOk).toBe(false);
    }

    // app/reveal-backups: fire-and-forget, ответ ok null вне зависимости от reveal (§9).
    await expect(dispatchOk(second, 'app/reveal-backups', {})).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  it('инвентарь (§5/§14): любой secure-канал вне разрешённого набора → STORAGE/RECOVERY_MODE', async () => {
    const dir = newUserDataDir();
    const first = await buildContainer({ userDataPath: dir, vault: () => new MockVault() });
    containers.push(first);
    first.db.exec('CREATE TABLE smoke_big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const insert = first.db.prepare('INSERT INTO smoke_big (v) VALUES (?)');
    first.db.transaction((rows: number) => {
      for (let i = 0; i < rows; i += 1) {
        insert.run(`row-${i}`);
      }
    })(400);
    const pageSize = first.db.pragma('page_size', { simple: true }) as number;
    first.close();
    corruptLastPage(join(dir, DATABASE_FILENAME), pageSize);

    const recoveryContainer = await buildContainer({
      userDataPath: dir,
      vault: () => new MockVault(),
    });
    containers.push(recoveryContainer);
    expect(recoveryContainer.recovery).toBeDefined();

    const recoveryAllowed = new Set(['backup/restore', 'data/discard-db']);
    // __bench/seed и __test/* — TEST-ONLY каналы (§9 062 bench; §5/§6/§14 102
    // крэш-тест NFR-3): в боевом реестре контейнера НЕ регистрируются — их
    // ставит bootstrap по env HL_BENCH/HL_TEST_HOOKS (только не-packaged, §14) —
    // из инвентаря исключены (вызов был бы APP/INTERNAL «неизвестный канал»).
    const secureChannels = Object.entries(CHANNEL_SCHEMAS)
      .filter(
        ([name, schemas]) =>
          name !== '__bench/seed' &&
          !name.startsWith('__test/') &&
          'secure' in schemas &&
          schemas.secure,
      )
      .map(([name]) => name);

    expect(secureChannels.length).toBeGreaterThan(10);
    for (const channel of secureChannels) {
      // Разрешённые каналы проверяются НЕВАЛИДНЫМ payload: гард пройден (отказ —
      // валидация, не RECOVERY_MODE), хендлер НЕ выполняется — data/discard-db
      // разрушающий (unlink db-файлов), исполнять его в инвентаре нельзя (§19).
      const payload =
        channel === 'data/discard-db' || channel === 'backup/restore' ? { extra: 1 } : {};
      const envelope = await recoveryContainer.channels.dispatch({ channel, payload });
      if (recoveryAllowed.has(channel)) {
        // Разрешённые проходят recovery-гвардию дальше (валидация payload → VALIDATION).
        expect(
          envelope.ok === false && envelope.error.code !== 'STORAGE/RECOVERY_MODE',
          `канал ${channel} должен пройти recovery-гвардию`,
        ).toBe(true);
        continue;
      }
      expect(
        envelope.ok === false && envelope.error.code === 'STORAGE/RECOVERY_MODE',
        `канал ${channel} обязан быть закрыт STORAGE/RECOVERY_MODE в recovery`,
      ).toBe(true);
    }
  });
});

describe('buildContainer — MIGRATION_FAILED-фикстура → тот же recovery (§20 AC5)', () => {
  it('миграция с ошибкой → контейнер не брошен, reason migration_failed, версия в деталях', async () => {
    const dir = newUserDataDir();
    // Старт №1: здоровая БД на максимальной версии реестра.
    const first = await buildContainer({ userDataPath: dir, vault: () => new MockVault() });
    containers.push(first);
    first.close();

    // Старт №2: реестр с фикстурой-миграцией v8, которая падает (TEST-ONLY deps.migrations).
    const failingMigration: Migration = {
      version: (MIGRATIONS.at(-1)?.version ?? 0) + 1,
      up: () => {
        throw new Error('фикстура-миграция с ошибкой (TASK-101 §19)');
      },
    };
    const second = await buildContainer({
      userDataPath: dir,
      vault: () => new MockVault(),
      migrations: [...MIGRATIONS, failingMigration],
    });
    containers.push(second);

    const recovery = second.recovery;
    expect(recovery).toBeDefined();
    expect(recovery?.reason).toBe('migration_failed');
    expect(recovery?.details.migrationVersion).toBe(failingMigration.version);

    // app/meta: recovery-контекст с migration_version; scale опущен.
    const meta = await dispatchOk(second, 'app/meta', {});
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      const data = meta.data as Record<string, unknown>;
      const recoveryData = data['recovery'] as Record<string, unknown> | undefined;
      expect(recoveryData?.['reason']).toBe('migration_failed');
      expect(
        (recoveryData?.['details'] as Record<string, unknown> | undefined)?.['migrationVersion'],
      ).toBe(failingMigration.version);
      expect(data['scale']).toBeUndefined();
    }

    // Secure-каналы закрыты тем же образом (проба: prefs/get).
    const prefs = await dispatchOk(second, 'prefs/get', {});
    expect(prefs).toEqual({ ok: false, error: { code: 'STORAGE/RECOVERY_MODE' } });
  });
});

describe('buildContainer — healthy-регрессия (TASK-101 §24 «откат: healthy — ветка недостижима»)', () => {
  it('healthy-старт: recovery нет; discard-канал не зарегистрирован; recovery-restore отклонён', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer({ userDataPath: dir, vault: () => new MockVault() });
    containers.push(container);

    expect(container.recovery).toBeUndefined();

    // app/meta: обычная форма — scale присутствует, recovery-поля нет.
    const meta = await dispatchOk(container, 'app/meta', {});
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      const data = meta.data as Record<string, unknown>;
      expect(data['scale']).toBeDefined();
      expect(data['recovery']).toBeUndefined();
    }

    // data/discard-db в здоровом режиме не зарегистрирован → APP/INTERNAL (неизвестный).
    const discard = await dispatchOk(container, 'data/discard-db', {});
    expect(discard).toEqual({ ok: false, error: { code: 'APP/INTERNAL' } });

    // backup/restore {recovery: true} в здоровом режиме — misuse-гвардия (§5:
    // восстановление без страховки/сравнения имеет смысл только в recovery).
    const misuse = await dispatchOk(container, 'backup/restore', {
      recovery: true,
      file: 'x.hlbackup',
      passphrase: 'пароль',
    });
    expect(misuse).toEqual({ ok: false, error: { code: 'VALIDATION/FAILED' } });

    // Страховка от случайной подмены: файл БД на месте (ключ-vault MockVault не
    // пишет — реальный файл ключа появляется только в SafeStorageKeyVault, §19).
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);
  });
});

describe('buildContainer — passphrase-режим с повреждённой БД (§5 «ветка dbOk=false»)', () => {
  it('unlock верным паролем проходит; recovery введён в openDatabase; secure-каналы закрыты', async () => {
    const dir = newUserDataDir();
    // Ключ ОДИН на сценарий: vault.key создаёт SafeStorageKeyVault (случайный K1),
    // БД создаётся СЕССИЕЙ passphrase (container1, K1) — иначе открытие упало бы
    // STORAGE/BAD_KEY (чужой ключ), а не порчей последней страницы (§19).
    const vaultFilePath = join(dir, VAULT_KEY_FILENAME);
    const setup = new SafeStorageKeyVault({
      vaultFilePath,
      safeStorage: new FakeSafeStorage(),
      clock: { nowMs: () => 0, tzOffsetMin: () => 0 },
      logger: silentVaultLogger,
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });
    unsafeUnwrap(await setup.ensureKey(false));
    unsafeUnwrap(await setup.setPassphrase(PASS));

    const vaultFactory = (context: {
      vaultFilePath: string;
      clock: { nowMs: () => number; tzOffsetMin: () => number };
      logger: VaultLogger;
    }): SafeStorageKeyVault =>
      new SafeStorageKeyVault({
        vaultFilePath: context.vaultFilePath,
        safeStorage: new FakeSafeStorage(),
        clock: context.clock,
        logger: context.logger,
        calibrate: () => Promise.resolve(FAST_PARAMS),
      });

    // Старт №1: сессия passphrase создаёт БД (K1) и наполняет многостраничной
    // таблицей — последняя страница файла станет leaf этой таблицы (прецедент 100).
    const first = await buildContainer({
      userDataPath: dir,
      vault: (context) => vaultFactory(context),
    });
    containers.push(first);
    const unlockedFirst = await first.vaultService.unlock(PASS);
    expect(unlockedFirst.ok).toBe(true);
    first.db.exec('CREATE TABLE smoke_big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const insert = first.db.prepare('INSERT INTO smoke_big (v) VALUES (?)');
    first.db.transaction((rows: number) => {
      for (let i = 0; i < rows; i += 1) {
        insert.run(`row-${i}-payload-padding`);
      }
    })(400);
    const pageSize = first.db.pragma('page_size', { simple: true }) as number;
    first.close();
    corruptLastPage(join(dir, DATABASE_FILENAME), pageSize);

    // Старт №2: до unlock БД не открывалась — recovery нет.
    const container = await buildContainer({
      userDataPath: dir,
      vault: (context) => vaultFactory(context),
    });
    containers.push(container);
    expect(container.recovery).toBeUndefined();

    // Пароль верен — unlock проходит; openDatabase видит dbOk=false → recovery.
    const unlocked = await container.vaultService.unlock(PASS);
    expect(unlocked.ok).toBe(true);
    const recovery = container.recovery;
    expect(recovery).toBeDefined();
    expect(recovery?.reason).toBe('corrupt');

    // app/meta несёт recovery-контекст — экран показывается сразу после входа.
    const meta = await dispatchOk(container, 'app/meta', {});
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      expect((meta.data as Record<string, unknown>)['recovery']).toBeDefined();
    }
    // Secure-каналы закрыты и в passphrase-recovery.
    const prefs = await dispatchOk(container, 'prefs/get', {});
    expect(prefs).toEqual({ ok: false, error: { code: 'STORAGE/RECOVERY_MODE' } });
  });
});
