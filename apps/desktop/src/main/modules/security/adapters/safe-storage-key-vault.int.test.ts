/**
 * TASK-023 §19/§20 + TASK-093 §19/§20: детерминированные тесты KeyVault на моке
 * SafeStorageApi (tmp-каталог), матрица кейсов:
 *
 * TASK-023 (§13, режим safeStorage):
 *  1. файла нет, БД нет      → ключ создан (crypto.randomBytes), записан, created=true;
 *  2. файл есть и валиден    → decrypt, created=false, ключ тот же;
 *  3. файл есть, расшифровать нельзя / не JSON / схема битая / мусор → VAULT/KEY_CORRUPT;
 *  4. файла нет после того, как БД существует (dbExists=true) → VAULT/KEY_MISSING;
 *  5. isEncryptionAvailable()=false → VAULT/UNAVAILABLE.
 *
 * TASK-093 (§19, двойная обёртка Argon2id + AES-256-GCM):
 *  - setPassphrase → getMode()='passphrase', файл v2 с saltB64/argonParams;
 *    новый экземпляр: ensureKey → VAULT/LOCKED (§9: БД не открывается до unlock);
 *  - unlock: верный пароль → ok, ensureKey отдаёт ТОТ ЖЕ ключ; неверный →
 *    VAULT/WRONG_PASSPHRASE (auth-tag GCM, файл не тронут);
 *  - changePassphrase: неверный old → WRONG_PASSPHRASE (файл не изменился); верный →
 *    переобёртка, ключ БД не меняется (инвариант §7), старый пароль больше не подходит;
 *  - removePassphrase → mode='none' (v2 safeStorage), ключ тот же, unlock не нужен;
 *  - потеря/порча salt/wrapped: схема-порча (нет saltB64, обрезан wrapped) →
 *    VAULT/KEY_CORRUPT; битые байты при валидной схеме → WRONG_PASSPHRASE
 *    (криптографически неотличимо от неверного пароля, §14 backup-crypto);
 *  - миграция v1→v2 при старте: фикстура v1-файла → ключ сохранён, файл на диске
 *    стал v2 (downgrade v2→v1 невозможен, §13);
 *  - калибровка: setPassphrase пишет параметры в файл (в коде их нет, §14);
 *  - §14: пароль/salt/wrappedKey не в логах и не в файле открытым текстом.
 *
 * Реальный safeStorage (DPAPI) в vitest-окружении node недоступен — real-проверка
 * отдельная, вручную на Windows: pnpm test:vault-real (§19).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { AppError, FixedClock, unsafeUnwrap, type Result } from '@hl/kernel';

import { VAULT_KEY_FILENAME } from '../../../shared/constants.js';
import {
  VAULT_LOCKED_MESSAGE_KEY,
  VAULT_WRONG_PASSPHRASE_MESSAGE_KEY,
  type EnsuredKey,
} from '../application/ports/key-vault.js';
import type { Argon2Params } from './passphrase-crypto.js';
import {
  SafeStorageKeyVault,
  type VaultLogger,
  type VaultSafeStorage,
} from './safe-storage-key-vault.js';
import { parseV2 } from './vault-format.js';

/** Момент FixedClock: createdUtc в файле детерминирован (§7). */
const NOW_MS = 1_700_000_000_000;

/** Префикс «шифротекста» мока: расшифровка без префикса = blob чужой машины/пользователя. */
const FAKE_PREFIX = 'hl-vault-test:';

/** Пароль тестов TASK-093 (§19: верный/неверный пути). */
const PASS = 'пароль-vault-теста';
const NEW_PASS = 'новый-пароль-vault';

/** Малые параметры калибровки тестов (8 МБ × 1 итерация — миллисекунды, §19). */
const FAST_PARAMS: Argon2Params = { iterations: 1, memoryKib: 8192, parallelism: 1 };

/**
 * Мок SafeStorageApi (§19). Режимы:
 *  - 'ok'      — симметричный «шифр» (префикс + открытый текст в буфере);
 *  - 'throw'   — decryptString бросает: платформа не может расшифровать (кейс 3);
 *  - 'foreign' — decryptString НЕ бросает, но возвращает мусор: расшифрованный
 *                текст не является 64-hex-ключом (вторая защита кейса 3).
 */
class FakeSafeStorage implements VaultSafeStorage {
  /** Spy-счётчики вызовов (§20: один decrypt за старт). */
  readonly calls = { encryptString: 0, decryptString: 0, isEncryptionAvailable: 0 };

  constructor(private mode: 'ok' | 'throw' | 'foreign' = 'ok') {}

  /** Смена режима между вызовами: сценарий «причину устранили — повтор удался». */
  setMode(mode: 'ok' | 'throw' | 'foreign'): void {
    this.mode = mode;
  }

  isEncryptionAvailable(): boolean {
    this.calls.isEncryptionAvailable += 1;
    return true;
  }

  encryptString(plainText: string): Buffer {
    this.calls.encryptString += 1;
    return Buffer.from(`${FAKE_PREFIX}${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    this.calls.decryptString += 1;
    if (this.mode === 'throw') {
      throw new Error('safeStorage: платформа не может расшифровать blob');
    }
    const text = Buffer.from(encrypted).toString('utf8');
    if (this.mode === 'foreign' || !text.startsWith(FAKE_PREFIX)) {
      return 'расшифрованный-мусор-не-ключ';
    }
    return text.slice(FAKE_PREFIX.length);
  }
}

/** Извлекает err-ветку для assert'ов; ok-ветка — ошибка теста (не молчаливый проход). */
const errOf = <T>(result: Result<T, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидалась err-ветка Result, получена ok');
  }
  return result.error;
};

/** Свежие spy-логгеры на тест (§18: проверяем факт и отсутствие секретов в мете). */
const makeLogger = (): {
  logger: VaultLogger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} => {
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { info, warn }, info, warn };
};

describe('SafeStorageKeyVault — режим safeStorage, кейсы §13 TASK-023 (v2-формат)', () => {
  /** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Свежий tmp-каталог на тест (изоляция сценариев друг от друга). */
  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-vault-int-'));
    dirs.push(dir);
    return dir;
  };

  /** Фабрика vault-а: путь файла — tmp-каталог + константа имени из shared (§6). */
  const makeVault = (
    dir: string,
    safeStorage: VaultSafeStorage = new FakeSafeStorage(),
    logger: VaultLogger = makeLogger().logger,
  ): SafeStorageKeyVault =>
    new SafeStorageKeyVault({
      vaultFilePath: join(dir, VAULT_KEY_FILENAME),
      safeStorage,
      clock: new FixedClock(NOW_MS, 180),
      logger,
      // §19: калибровка подставляется — быстрые параметры (миллисекунды).
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });

  /** Путь файла ключа в каталоге (читаемость тестов). */
  const keyFile = (dir: string): string => join(dir, VAULT_KEY_FILENAME);

  /** Разобранный JSON файла ключа — как его увидит любой читатель файла (§5). */
  const readRawFile = (dir: string): string => readFileSync(keyFile(dir), 'utf8');

  it('кейс 1: файла нет, БД нет → ключ создан, записан v2 safeStorage, created=true (§13)', async () => {
    const dir = newDir();
    const fake = new FakeSafeStorage();
    const { logger } = makeLogger();
    const vault = makeVault(dir, fake, logger);

    const result = await vault.ensureKey(false);

    const ensured = unsafeUnwrap(result);
    expect(ensured.created).toBe(true);
    // Инвариант §7: 32 байта = 64 hex-символа lowercase.
    expect(ensured.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(keyFile(dir))).toBe(true);
    expect(vault.getMode()).toBe('none');

    // Формат файла §5 (TASK-093): v2, mode safeStorage, wrappedKeyB64, createdUtc.
    const blob = parseV2(readRawFile(dir));
    expect(blob).toMatchObject({ v: 2, mode: 'safeStorage', createdUtc: NOW_MS });
    expect(blob?.wrappedKeyB64.length).toBeGreaterThan(0);
    // wrapped действительно оборачивает ИМЕННО этот ключ (roundtrip через тот же мок).
    expect(fake.decryptString(Buffer.from(blob?.wrappedKeyB64 ?? '', 'base64'))).toBe(
      ensured.keyHex,
    );
  });

  it('кейс 2: файл есть и валиден → decrypt, created=false, ключ тот же (§13)', async () => {
    const dir = newDir();
    const first = makeVault(dir);
    const created = unsafeUnwrap(await first.ensureKey(false));

    // Вторая сессия = новый экземпляр адаптера над тем же файлом (и тот же keyring).
    const second = makeVault(dir);
    const reopened = unsafeUnwrap(await second.ensureKey(true));
    expect(reopened.created).toBe(false);
    expect(reopened.keyHex).toBe(created.keyHex);

    // dbExists при существующем файле на результат не влияет.
    const third = makeVault(dir);
    const again = unsafeUnwrap(await third.ensureKey(false));
    expect(again.created).toBe(false);
    expect(again.keyHex).toBe(created.keyHex);
  });

  it('кейс 3а: файл есть, decryptString бросает → VAULT/KEY_CORRUPT (§13)', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    unsafeUnwrap(await makeVault(dir, new FakeSafeStorage(), logger).ensureKey(false));

    // Сменился Windows-пользователь/машина: keyring не может расшифровать blob.
    const moved = makeVault(dir, new FakeSafeStorage('throw'), logger);
    const error = errOf(await moved.ensureKey(true));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('VAULT/KEY_CORRUPT');
  });

  it('кейс 3б: файл есть, расшифрованный текст — не 64-hex → VAULT/KEY_CORRUPT (§13)', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    unsafeUnwrap(await makeVault(dir, new FakeSafeStorage(), logger).ensureKey(false));

    // Чужой keyring «расшифровывает» в мусор — ключом это быть не может.
    const foreign = makeVault(dir, new FakeSafeStorage('foreign'), logger);
    const error = errOf(await foreign.ensureKey(false));

    expect(error.code).toBe('VAULT/KEY_CORRUPT');
  });

  it('кейс 3в: файл не JSON и схема не v1/v2 → VAULT/KEY_CORRUPT (§13)', async () => {
    // Содержимое файла всегда строка (utf8); «мусор» — в структуре JSON, не в типе.
    const invalidPayloads: string[] = [
      'not-json{',
      JSON.stringify({ v: 3, wrappedKeyB64: 'aaa', createdUtc: 1 }),
      JSON.stringify({ v: 2, wrappedKeyB64: 42, createdUtc: 1 }),
      JSON.stringify({ v: 2, mode: 'safeStorage', createdUtc: 1 }), // нет обёртки
      JSON.stringify({ v: 1, wrapped: 42, createdUtc: 1 }),
      JSON.stringify({ v: 1, wrapped: 'aaa', createdUtc: 'не-число' }),
      JSON.stringify({ v: 1, wrapped: 'aaa' }),
      JSON.stringify({}),
    ];

    for (const payload of invalidPayloads) {
      const fresh = newDir();
      writeFileSync(keyFile(fresh), payload, 'utf8');
      const vault = makeVault(fresh);
      expect(errOf(await vault.ensureKey(false)).code, payload).toBe('VAULT/KEY_CORRUPT');
    }
  });

  it('кейс 4: файла нет, БД существует (dbExists=true) → VAULT/KEY_MISSING, ключ НЕ генерируется (§13/§20)', async () => {
    const dir = newDir();
    const fake = new FakeSafeStorage();
    const { logger } = makeLogger();
    const vault = makeVault(dir, fake, logger);

    const error = errOf(await vault.ensureKey(true));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('VAULT/KEY_MISSING');
    // §20: не генерировать новый! Ни шифрования, ни файла.
    expect(fake.calls.encryptString).toBe(0);
    expect(existsSync(keyFile(dir))).toBe(false);
  });

  it('кейс 5: isEncryptionAvailable()=false → VAULT/UNAVAILABLE (§13)', async () => {
    const dir = newDir();
    const fake = new FakeSafeStorage();
    vi.spyOn(fake, 'isEncryptionAvailable').mockReturnValue(false);
    const { logger } = makeLogger();
    const vault = makeVault(dir, fake, logger);

    // Создание невозможно.
    const createError = errOf(await vault.ensureKey(false));
    expect(createError).toBeInstanceOf(AppError);
    expect(createError.code).toBe('VAULT/UNAVAILABLE');
    expect(fake.calls.encryptString).toBe(0);
    expect(existsSync(keyFile(dir))).toBe(false);

    // Чтение тоже: без keyring расшифровка невозможна — та же явная ошибка.
    writeFileSync(
      keyFile(dir),
      JSON.stringify({
        v: 2,
        mode: 'safeStorage',
        wrappedKeyB64: Buffer.alloc(32, 1).toString('base64'),
        createdUtc: 1,
      }),
      'utf8',
    );
    const readError = errOf(await vault.ensureKey(true));
    expect(readError.code).toBe('VAULT/UNAVAILABLE');
    // Доступность проверяется ДО выбора сценария: unavailable + dbExists → UNAVAILABLE, не KEY_MISSING.
    expect(fake.calls.decryptString).toBe(0);
  });

  it('grep-тест §14/§20: файл vault.key не содержит ключа открытым текстом', async () => {
    const dir = newDir();
    const vault = makeVault(dir);
    const ensured = unsafeUnwrap(await vault.ensureKey(false));

    const content = readRawFile(dir);
    expect(content).not.toContain(ensured.keyHex);
    // Ни одной 64-hex-строки вообще: ключ не просачивается даже частично-подобным видом.
    expect(/[0-9a-f]{64}/.test(content)).toBe(false);
  });

  it('§20: повторный ensureKey в сессии — один decrypt (spy-счётчик), результат кэширован', async () => {
    const dir = newDir();
    const fake = new FakeSafeStorage();
    const { logger } = makeLogger();
    const vault = makeVault(dir, fake, logger);
    unsafeUnwrap(await vault.ensureKey(false));

    const first = unsafeUnwrap(await vault.ensureKey(false));
    const second = unsafeUnwrap(await vault.ensureKey(true));
    expect(second).toEqual(first);
    expect(fake.calls.encryptString).toBe(1);

    // Чтение существующего: расшифровка один раз за старт адаптера.
    const readDir = newDir();
    const readFake = new FakeSafeStorage();
    const readVault = makeVault(readDir, readFake, logger);
    unsafeUnwrap(await readVault.ensureKey(false));
    const freshVault = makeVault(readDir, readFake, logger);
    unsafeUnwrap(await freshVault.ensureKey(true));
    unsafeUnwrap(await freshVault.ensureKey(true));
    expect(readFake.calls.decryptString).toBe(1);
  });

  it('§13: err-результат не кэшируется — повторный ensureKey после устранимой причины работает', async () => {
    const dir = newDir();
    const fake = new FakeSafeStorage();
    const { logger } = makeLogger();
    const vault = makeVault(dir, fake, logger);

    // 1) Неуспех: файла ключа нет, БД существует.
    expect(errOf(await vault.ensureKey(true)).code).toBe('VAULT/KEY_MISSING');

    // 2) «Восстановление из копии» (§3, TASK-101): файл ключа появился внешне —
    //    ТОТ ЖЕ экземпляр vault-а подхватывает его (err-результат не кэшируется).
    const sourceDir = newDir();
    const restoredKey = unsafeUnwrap(await makeVault(sourceDir).ensureKey(false)).keyHex;
    writeFileSync(keyFile(dir), readFileSync(keyFile(sourceDir), 'utf8'), 'utf8');

    const recovered = unsafeUnwrap(await vault.ensureKey(true));
    expect(recovered.created).toBe(false);
    expect(recovered.keyHex).toBe(restoredKey);
  });

  it('§18: лог «vault key ensured» — факт с created, без ключа; неуспех — warn с кодом', async () => {
    const dir = newDir();
    const { logger, info, warn } = makeLogger();
    const vault = makeVault(dir, new FakeSafeStorage(), logger);
    const ensured = unsafeUnwrap(await vault.ensureKey(false));

    expect(info).toHaveBeenCalledTimes(1);
    const [message, meta] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('vault key ensured');
    expect(meta).toEqual({ created: ensured.created });
    expect(JSON.stringify(info.mock.calls)).not.toContain(ensured.keyHex);

    // Неуспех: код ошибки в warn — без секретов (ключа в метах нет по построению).
    const missing = makeVault(newDir(), new FakeSafeStorage(), logger);
    expect(errOf(await missing.ensureKey(true)).code).toBe('VAULT/KEY_MISSING');
    const [warnMessage, warnMeta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(warnMessage).toBe('vault key ensure failed');
    expect(warnMeta).toEqual({ code: 'VAULT/KEY_MISSING' });
  });

  it('exportKeyForBackup: wrapped-blob §7 без расшифровки; файла нет → KEY_MISSING; повреждён → KEY_CORRUPT', async () => {
    const dir = newDir();
    const vault = makeVault(dir);
    unsafeUnwrap(await vault.ensureKey(false));

    const blob = unsafeUnwrap(await vault.exportKeyForBackup());
    expect(blob).toEqual({
      v: 2,
      wrappedB64: parseV2(readRawFile(dir))?.wrappedKeyB64,
      createdUtc: NOW_MS,
    });

    // Пустой каталог: файла ключа нет.
    const empty = makeVault(newDir());
    expect(errOf(await empty.exportKeyForBackup()).code).toBe('VAULT/KEY_MISSING');

    // Повреждённый файл.
    const corruptDir = newDir();
    writeFileSync(keyFile(corruptDir), 'not-json{', 'utf8');
    const corrupt = makeVault(corruptDir);
    expect(errOf(await corrupt.exportKeyForBackup()).code).toBe('VAULT/KEY_CORRUPT');
  });

  it('exportKeyForBackup не требует keyring: читает wrapped-blob как есть (§5: UI решит, TASK-073)', async () => {
    const dir = newDir();
    // Файл создан, пока keyring был доступен...
    unsafeUnwrap(await makeVault(dir).ensureKey(false));

    // ...затем keyring стал недоступен — export всё равно читает wrapped-blob.
    const unavailable = new FakeSafeStorage();
    vi.spyOn(unavailable, 'isEncryptionAvailable').mockReturnValue(false);
    const vault = makeVault(dir, unavailable);

    const blob = unsafeUnwrap(await vault.exportKeyForBackup());
    expect(blob.v).toBe(2);
    expect(blob.wrappedB64).toBe(parseV2(readRawFile(dir))?.wrappedKeyB64);
  });

  it('тип EnsuredKey экспортируется портом: ensureKey возвращает {keyHex, created} (§5)', async () => {
    const dir = newDir();
    const vault = makeVault(dir);

    const ensured: EnsuredKey = unsafeUnwrap(await vault.ensureKey(false));
    expect(Object.keys(ensured).sort()).toEqual(['created', 'keyHex']);
  });

  it('миграция v1→v2 при старте: фикстура v1 → ключ сохранён, файл стал v2, downgrade невозможен (§5/§13/§20)', async () => {
    const dir = newDir();
    // Файл v1 создаётся боевой логикой старого формата: ключ обёрнут тем же моком.
    const sourceDir = newDir();
    const legacyKey = unsafeUnwrap(await makeVault(sourceDir).ensureKey(false)).keyHex;
    const legacyBlob = JSON.parse(readRawFile(sourceDir)) as {
      v: number;
      wrappedKeyB64: string;
      createdUtc: number;
    };
    expect(legacyBlob.v).toBe(2); // новая установка рождается в v2 — фикстуру v1 собираем вручную
    writeFileSync(
      keyFile(dir),
      JSON.stringify({
        v: 1,
        wrapped: legacyBlob.wrappedKeyB64,
        createdUtc: legacyBlob.createdUtc,
      }),
      'utf8',
    );
    expect(parseV2(readRawFile(dir))).toBeUndefined(); // до старта файл — v1

    // Первый старт с v1-файлом: ключ расшифрован, файл ПЕРЕЗАПИСАН в v2.
    const vault = makeVault(dir);
    const ensured = unsafeUnwrap(await vault.ensureKey(true));
    expect(ensured.created).toBe(false);
    expect(ensured.keyHex).toBe(legacyKey);

    const migrated = parseV2(readRawFile(dir));
    expect(migrated).toMatchObject({
      v: 2,
      mode: 'safeStorage',
      wrappedKeyB64: legacyBlob.wrappedKeyB64,
      createdUtc: legacyBlob.createdUtc,
    });
    // Downgrade v2→v1 невозможен (§13): старая v1-схема в файле больше не встречается.
    expect(readRawFile(dir)).not.toContain('"wrapped"');
    // Повторный старт — миграции больше нет, ключ тот же.
    const second = unsafeUnwrap(await makeVault(dir).ensureKey(true));
    expect(second.keyHex).toBe(legacyKey);
  });

  it('getMode: файла нет / v1 / v2-safeStorage / повреждён → none; v2-passphrase → passphrase (§7)', async () => {
    const empty = makeVault(newDir());
    expect(empty.getMode()).toBe('none');

    const corrupt = newDir();
    writeFileSync(keyFile(corrupt), 'not-json{', 'utf8');
    expect(makeVault(corrupt).getMode()).toBe('none');

    const passphrase = newDir();
    const vault = makeVault(passphrase);
    unsafeUnwrap(await vault.ensureKey(false));
    unsafeUnwrap(await vault.setPassphrase(PASS));
    expect(vault.getMode()).toBe('passphrase');
    expect(makeVault(passphrase).getMode()).toBe('passphrase');
  });
});

describe('SafeStorageKeyVault — двойная обёртка (TASK-093 §19: set/unlock/change/remove)', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-vault-pass-'));
    dirs.push(dir);
    return dir;
  };

  const keyFile = (dir: string): string => join(dir, VAULT_KEY_FILENAME);

  const makeVault = (
    dir: string,
    safeStorage: VaultSafeStorage = new FakeSafeStorage(),
    logger: VaultLogger = makeLogger().logger,
  ): SafeStorageKeyVault =>
    new SafeStorageKeyVault({
      vaultFilePath: keyFile(dir),
      safeStorage,
      clock: new FixedClock(NOW_MS, 180),
      logger,
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });

  /** Сценарий «первая установка без пароля»: ключ создан, mode=none. */
  const setupUnprotected = async (dir: string): Promise<{ keyHex: string }> => {
    const vault = makeVault(dir);
    const ensured = unsafeUnwrap(await vault.ensureKey(false));
    return { keyHex: ensured.keyHex };
  };

  it('setPassphrase: ok; getMode=passphrase; файл v2 c saltB64/argonParams; ключ не изменился (§5/§13)', async () => {
    const dir = newDir();
    const { keyHex } = await setupUnprotected(dir);
    const vault = makeVault(dir);

    const result = await vault.setPassphrase(PASS);

    expect(result.ok).toBe(true);
    expect(vault.getMode()).toBe('passphrase');
    const blob = parseV2(readFileSync(keyFile(dir), 'utf8'));
    expect(blob).toMatchObject({ v: 2, mode: 'passphrase', createdUtc: NOW_MS });
    if (blob?.mode !== 'passphrase') {
      throw new Error('ожидался passphrase-файл v2');
    }
    expect(blob.saltB64.length).toBeGreaterThan(0);
    // Калибровка в файле (§14: параметры — не в коде); тест-параметры известны.
    expect(blob.argonParams).toEqual(FAST_PARAMS);
    // Обёртка НЕ равна safeStorage-blob'у (ключ переобёрнут GCM), ключ прежний.
    expect(blob.wrappedKeyB64.length).toBeGreaterThan(0);
    expect(unsafeUnwrap(await vault.ensureKey(true)).keyHex).toBe(keyHex);
  });

  it('set→unlock-ок (новая сессия): до unlock — VAULT/LOCKED; верный пароль → тот же ключ (§9/§19)', async () => {
    const dir = newDir();
    const { keyHex } = await setupUnprotected(dir);
    unsafeUnwrap(await makeVault(dir).setPassphrase(PASS));

    // Новая сессия (новый экземпляр): ensureKey до unlock — VAULT/LOCKED (§9).
    const locked = makeVault(dir);
    expect(locked.getMode()).toBe('passphrase');
    const lockedError = errOf(await locked.ensureKey(false));
    expect(lockedError).toBeInstanceOf(AppError);
    expect(lockedError.code).toBe('VAULT/LOCKED');
    expect(lockedError.messageKey).toBe(VAULT_LOCKED_MESSAGE_KEY);
    // И при существующей БД, и без — до unlock ключа нет.
    expect(errOf(await locked.ensureKey(true)).code).toBe('VAULT/LOCKED');

    // unlock неверным паролем → VAULT/WRONG_PASSPHRASE; ключ по-прежнему закрыт.
    expect(errOf(await locked.unlock('неверный-пароль')).code).toBe('VAULT/WRONG_PASSPHRASE');
    expect(errOf(await locked.ensureKey(false)).code).toBe('VAULT/LOCKED');

    // unlock верным → ok; ensureKey отдаёт исходный ключ БД (данные читаемы, §20).
    expect((await locked.unlock(PASS)).ok).toBe(true);
    const ensured = unsafeUnwrap(await locked.ensureKey(false));
    expect(ensured.keyHex).toBe(keyHex);
    expect(ensured.created).toBe(false);
  });

  it('unlock: порча/потеря salt и wrapped → KEY_CORRUPT; битые байты валидной схемы → WRONG_PASSPHRASE (§13)', async () => {
    // Потеря saltB64 (схема-порча) → KEY_CORRUPT.
    const noSalt = newDir();
    await setupUnprotected(noSalt);
    unsafeUnwrap(await makeVault(noSalt).setPassphrase(PASS));
    const noSaltBlob = JSON.parse(readFileSync(keyFile(noSalt), 'utf8')) as Record<string, unknown>;
    delete noSaltBlob.saltB64;
    writeFileSync(keyFile(noSalt), JSON.stringify(noSaltBlob), 'utf8');
    expect(errOf(await makeVault(noSalt).unlock(PASS)).code).toBe('VAULT/KEY_CORRUPT');

    // Обрезанный wrappedKeyB64 (схема-порча) → KEY_CORRUPT.
    const truncated = newDir();
    await setupUnprotected(truncated);
    unsafeUnwrap(await makeVault(truncated).setPassphrase(PASS));
    const truncatedBlob = JSON.parse(readFileSync(keyFile(truncated), 'utf8')) as Record<
      string,
      unknown
    >;
    truncatedBlob.wrappedKeyB64 = Buffer.from('обрезано').toString('base64');
    writeFileSync(keyFile(truncated), JSON.stringify(truncatedBlob), 'utf8');
    expect(errOf(await makeVault(truncated).unlock(PASS)).code).toBe('VAULT/KEY_CORRUPT');

    // Битый байт шифртекста при валидной схеме: GCM-tag → WRONG_PASSPHRASE
    // (криптографически неотличимо от неверного пароля — §14 backup-crypto).
    const tampered = newDir();
    await setupUnprotected(tampered);
    unsafeUnwrap(await makeVault(tampered).setPassphrase(PASS));
    const tamperedBlob = JSON.parse(readFileSync(keyFile(tampered), 'utf8')) as {
      wrappedKeyB64: string;
    };
    const raw = Buffer.from(tamperedBlob.wrappedKeyB64, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    tamperedBlob.wrappedKeyB64 = raw.toString('base64');
    writeFileSync(keyFile(tampered), JSON.stringify(tamperedBlob), 'utf8');
    expect(errOf(await makeVault(tampered).unlock(PASS)).code).toBe('VAULT/WRONG_PASSPHRASE');
  });

  it('changePassphrase: неверный old → WRONG_PASSPHRASE (файл не изменился); верный → переобёртка, ключ тот же, old больше не подходит (§13/§20)', async () => {
    const dir = newDir();
    const { keyHex } = await setupUnprotected(dir);
    unsafeUnwrap(await makeVault(dir).setPassphrase(PASS));
    const before = readFileSync(keyFile(dir), 'utf8');

    // Неверный old: отказ, файл байт-в-байт тот же (переобёртки нет).
    const wrongError = errOf(await makeVault(dir).changePassphrase('неверный', NEW_PASS));
    expect(wrongError.code).toBe('VAULT/WRONG_PASSPHRASE');
    expect(wrongError.messageKey).toBe(VAULT_WRONG_PASSPHRASE_MESSAGE_KEY);
    expect(readFileSync(keyFile(dir), 'utf8')).toBe(before);

    // Верный old: ок; новая сессия — new подходит, old нет; ключ БД не изменился (§7).
    expect((await makeVault(dir).changePassphrase(PASS, NEW_PASS)).ok).toBe(true);
    const reopened = makeVault(dir);
    expect(errOf(await reopened.unlock(PASS)).code).toBe('VAULT/WRONG_PASSPHRASE');
    expect((await reopened.unlock(NEW_PASS)).ok).toBe(true);
    expect(unsafeUnwrap(await reopened.ensureKey(false)).keyHex).toBe(keyHex);
    // Файл изменился (новая соль/обёртка), остался в режиме passphrase.
    const after = parseV2(readFileSync(keyFile(dir), 'utf8'));
    expect(after).toMatchObject({ v: 2, mode: 'passphrase' });
  });

  it('changePassphrase вне passphrase-режима → отказ (контракт: сначала setPassphrase)', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    const error = errOf(await makeVault(dir).changePassphrase(PASS, NEW_PASS));
    expect(error.code).toBe('APP/INTERNAL');
  });

  it('setPassphrase при уже включённом пароле → отказ (контракт: changePassphrase)', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    const vault = makeVault(dir);
    unsafeUnwrap(await vault.setPassphrase(PASS));
    expect(errOf(await vault.setPassphrase(NEW_PASS)).code).toBe('APP/INTERNAL');
  });

  it('removePassphrase: верный old → mode=none, ключ тот же, unlock не нужен; неверный → WRONG_PASSPHRASE (§13/§19)', async () => {
    const dir = newDir();
    const { keyHex } = await setupUnprotected(dir);
    unsafeUnwrap(await makeVault(dir).setPassphrase(PASS));

    // Неверный old: отказ, пароль остался.
    expect(errOf(await makeVault(dir).removePassphrase('неверный')).code).toBe(
      'VAULT/WRONG_PASSPHRASE',
    );
    expect(makeVault(dir).getMode()).toBe('passphrase');

    // Верный old: возврат в safeStorage; новая сессия читает ключ без unlock.
    const { logger, info } = makeLogger();
    expect((await makeVault(dir, new FakeSafeStorage(), logger).removePassphrase(PASS)).ok).toBe(
      true,
    );
    expect(parseV2(readFileSync(keyFile(dir), 'utf8'))).toMatchObject({
      v: 2,
      mode: 'safeStorage',
      createdUtc: NOW_MS,
    });
    // §18: смена режима — в лог (зеркальное сообщение), без секретов.
    expect(JSON.stringify(info.mock.calls)).toContain('vault mode changed');
    expect(JSON.stringify(info.mock.calls)).not.toContain(PASS);

    const reopened = makeVault(dir);
    expect(reopened.getMode()).toBe('none');
    expect(unsafeUnwrap(await reopened.ensureKey(false)).keyHex).toBe(keyHex);
  });

  it('removePassphrase без пароля (mode=none) → идемпотентный ok; файла нет → KEY_MISSING (§13)', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    expect((await makeVault(dir).removePassphrase('любой')).ok).toBe(true);
    expect(errOf(await makeVault(newDir()).removePassphrase(PASS)).code).toBe('VAULT/KEY_MISSING');
  });

  it('exportKeyForBackup в passphrase-режиме → APP/NOT_IMPLEMENTED (резервный ключ с паролем — TASK-094/101)', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    const vault = makeVault(dir);
    unsafeUnwrap(await vault.setPassphrase(PASS));
    expect(errOf(await vault.exportKeyForBackup()).code).toBe('APP/NOT_IMPLEMENTED');
  });

  it('unlock без парольного режима → идемпотентный ok; файла нет → KEY_MISSING (§5)', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    expect((await makeVault(dir).unlock(PASS)).ok).toBe(true);
    expect(errOf(await makeVault(newDir()).unlock(PASS)).code).toBe('VAULT/KEY_MISSING');
  });

  it('§18: unlock — лог «vault unlock attempt» без пароля и без результата; смена режима — «vault mode changed»', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    // Смена режима в другой сессии — её логгер не проверяем.
    unsafeUnwrap(await makeVault(dir).setPassphrase(PASS));

    // Новая (заблокированная) сессия: попытки unlock — в её логе.
    const { logger, info } = makeLogger();
    const vault = makeVault(dir, new FakeSafeStorage(), logger);

    expect(errOf(await vault.unlock('неверный')).code).toBe('VAULT/WRONG_PASSPHRASE');
    expect((await vault.unlock(PASS)).ok).toBe(true);

    // Ровно один лог на попытку (две попытки) — исход (ok/err) в лог не попадает
    // (§18: счётчики неудач — rate-limit 094).
    expect(info.mock.calls.length).toBe(2);
    for (const call of info.mock.calls) {
      const [message] = call as [string, Record<string, unknown> | undefined];
      expect(message).toBe('vault unlock attempt');
      expect(JSON.stringify(call)).not.toContain(PASS);
    }
    expect(JSON.stringify(info.mock.calls)).not.toContain(PASS);
  });

  it('§14/§20 redact-границы адаптера: пароль/salt/обёртка не попадают в логи set/change/remove/unlock', async () => {
    const dir = newDir();
    await setupUnprotected(dir);
    const { logger, info, warn } = makeLogger();
    const vault = makeVault(dir, new FakeSafeStorage(), logger);

    unsafeUnwrap(await vault.setPassphrase(PASS));
    expect(errOf(await vault.changePassphrase('неверный', NEW_PASS)).code).toBe(
      'VAULT/WRONG_PASSPHRASE',
    );
    unsafeUnwrap(await vault.changePassphrase(PASS, NEW_PASS));
    unsafeUnwrap(await vault.removePassphrase(NEW_PASS));
    void warn;

    const everything = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(everything).not.toContain(PASS);
    expect(everything).not.toContain(NEW_PASS);
    expect(everything).not.toContain('неверный');
    // salt/обёртка (base64 из файла) — не в логах: имена полей redact-списка + факт отсутствия.
    const fileBlob = parseV2(readFileSync(keyFile(dir), 'utf8'));
    expect(everything).not.toContain(fileBlob?.wrappedKeyB64 ?? 'файл-не-прочитан');
  });
});

describe('SafeStorageKeyVault — импорт ключа из копии (TASK-121 §3/§5)', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-vault-import-'));
    dirs.push(dir);
    return dir;
  };

  const keyFile = (dir: string): string => join(dir, VAULT_KEY_FILENAME);

  const makeVault = (
    dir: string,
    safeStorage: VaultSafeStorage = new FakeSafeStorage(),
    logger: VaultLogger = makeLogger().logger,
  ): SafeStorageKeyVault =>
    new SafeStorageKeyVault({
      vaultFilePath: keyFile(dir),
      safeStorage,
      clock: new FixedClock(NOW_MS, 180),
      logger,
      calibrate: () => Promise.resolve({ iterations: 1, memoryKib: 8192, parallelism: 1 }),
    });

  it('importKey: файл переписан v2 safeStorage с импортированным ключом; ensureKey отдаёт его', async () => {
    const dir = newDir();
    const { logger, info } = makeLogger();
    // У профиля был СВОЙ ключ (боевой путь: пустой профиль Б при старте).
    const localKey = unsafeUnwrap(
      await makeVault(dir, new FakeSafeStorage(), logger).ensureKey(false),
    );
    const foreignKey = 'ab'.repeat(32);

    const vault = makeVault(dir, new FakeSafeStorage(), logger);
    const result = await vault.importKey(foreignKey);

    expect(result.ok).toBe(true);
    // Файл v2 mode='safeStorage', createdUtc — момент импорта (FixedClock).
    const blob = parseV2(readFileSync(keyFile(dir), 'utf8'));
    expect(blob).toMatchObject({ v: 2, mode: 'safeStorage', createdUtc: NOW_MS });
    // wrapped оборачивает ИМЕННО импортированный ключ (roundtrip тем же моком).
    expect(
      new FakeSafeStorage().decryptString(Buffer.from(blob?.wrappedKeyB64 ?? '', 'base64')),
    ).toBe(foreignKey);
    // Кэш сессии переехал: ensureKey того же экземпляра отдаёт импортированный ключ.
    const ensured = unsafeUnwrap(await vault.ensureKey(true));
    expect(ensured.keyHex).toBe(foreignKey);
    expect(ensured.keyHex).not.toBe(localKey);
    // Новая сессия (новый экземпляр) — тоже импортированный ключ, без unlock.
    expect(unsafeUnwrap(await makeVault(dir).ensureKey(true)).keyHex).toBe(foreignKey);
    // §18: факт импорта в логе, сам ключ — нет.
    expect(JSON.stringify(info.mock.calls)).toContain('vault key imported from backup copy');
    expect(JSON.stringify(info.mock.calls)).not.toContain(foreignKey);
  });

  it('importKey затирает passphrase-режим прежнего vault-а (восстановление заменяет всё, §3)', async () => {
    const dir = newDir();
    await makeVault(dir).ensureKey(false);
    expect((await makeVault(dir).setPassphrase(PASS)).ok).toBe(true);
    expect(makeVault(dir).getMode()).toBe('passphrase');

    const vault = makeVault(dir);
    expect((await vault.importKey('cd'.repeat(32))).ok).toBe(true);
    // Режим passphrase прежнего ключа не переносится (TASK-121 §3 «не включено»):
    // после импорта vault в safeStorage-режиме, unlock не нужен.
    expect(vault.getMode()).toBe('none');
    expect(unsafeUnwrap(await makeVault(dir).ensureKey(true)).keyHex).toBe('cd'.repeat(32));
  });

  it('importKey: нет ОС-хранилища → VAULT/UNAVAILABLE (файл не тронут); нарушение keyHex — TypeError', async () => {
    const dir = newDir();
    await makeVault(dir).ensureKey(false);
    const before = readFileSync(keyFile(dir), 'utf8');

    const unavailable = new FakeSafeStorage();
    vi.spyOn(unavailable, 'isEncryptionAvailable').mockReturnValue(false);
    const error = errOf(await makeVault(dir, unavailable).importKey('ab'.repeat(32)));
    expect(error.code).toBe('VAULT/UNAVAILABLE');
    expect(readFileSync(keyFile(dir), 'utf8')).toBe(before);

    // Dev-контракт 64-hex: нарушение — TypeError в точке вызова.
    await expect(makeVault(dir).importKey('не-hex')).rejects.toThrow(TypeError);
    await expect(makeVault(dir).importKey('ab'.repeat(31))).rejects.toThrow(TypeError);
  });
});

describe('TASK-122: сериализация мутаций с летящим ensureKey (окно гонки на свежем профиле)', () => {
  /** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-vault-race-'));
    dirs.push(dir);
    return dir;
  };
  /** Локальная фабрика (makeVault первого describe — в его замыкании, §19). */
  const makeRaceVault = (dir: string): SafeStorageKeyVault =>
    new SafeStorageKeyVault({
      vaultFilePath: join(dir, VAULT_KEY_FILENAME),
      safeStorage: new FakeSafeStorage(),
      clock: new FixedClock(NOW_MS, 180),
      logger: makeLogger().logger,
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });

  it('setPassphrase во время летящего ensureKey → сериализуется: ok (не призрачный KEY_MISSING), файл passphrase, unlock принимает пароль', async () => {
    const dir = newDir();
    const vault = makeRaceVault(dir);
    // Кейс 1 (генерация + запись) в полёте — НЕ ждём его перед мутацией.
    const ensured = vault.ensureKey(false);
    const set = await vault.setPassphrase(PASS);
    const ensuredResult = await ensured;
    // Оба исхода ok: ensureKey создал ключ, setPassphrase переобёрнул УЖЕ записанный файл.
    expect(ensuredResult.ok).toBe(true);
    expect(set.ok).toBe(true);
    if (!set.ok || !ensuredResult.ok) return;
    expect(vault.getMode()).toBe('passphrase');
    // «Перезапуск»: новый экземпляр — LOCKED до unlock, пароль из этого сеанса работает.
    const next = makeRaceVault(dir);
    const locked = await next.ensureKey(false);
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.error.code).toBe('VAULT/LOCKED');
    expect((await next.unlock(PASS)).ok).toBe(true);
    const reopened = unsafeUnwrap(await next.ensureKey(false));
    expect(reopened.keyHex).toBe(ensuredResult.value.keyHex);
  });

  it('importKey во время летящего ensureKey → финальный файл несёт ИМПОРТИРОВАННЫЙ ключ (запись кейса 1 не перекрывает её)', async () => {
    const dir = newDir();
    const vault = makeRaceVault(dir);
    const importedKey = 'ab'.repeat(32);
    const ensured = vault.ensureKey(false); // в полёте
    const importResult = await vault.importKey(importedKey);
    await ensured;
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;
    // Новый экземпляр на том же файле: ensureKey обязан выдать ИМПОРТИРОВАННЫЙ ключ —
    // без сериализации завершившийся generateAndStore перезаписал бы файл своим
    // ключом (ключ БД и vault расходятся → при следующем старте чужой ключ).
    const reopened = unsafeUnwrap(await makeRaceVault(dir).ensureKey(false));
    expect(reopened.keyHex).toBe(importedKey);
  });
});
