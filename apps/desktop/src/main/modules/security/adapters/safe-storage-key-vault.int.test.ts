/**
 * TASK-023 §19/§20: детерминированные тесты KeyVault на моке SafeStorageApi
 * (интерфейс §19: encrypt/decryptString/isEncryptionAvailable) — tmp-каталог,
 * матрица кейсов §13:
 *  1. файла нет, БД нет      → ключ создан (crypto.randomBytes), записан, created=true;
 *  2. файл есть и валиден    → decrypt, created=false, ключ тот же;
 *  3. файл есть, расшифровать нельзя (сменился Windows-пользователь/машина) /
 *     файл не JSON / схема не v1 / расшифрованный текст — не 64-hex → VAULT/KEY_CORRUPT;
 *  4. файла нет после того, как БД существует (dbExists=true) → VAULT/KEY_MISSING,
 *     новый ключ НЕ генерируется (§20);
 *  5. isEncryptionAvailable()=false → VAULT/UNAVAILABLE (и на создании, и на чтении).
 *
 * Плюс критерии §20:
 *  - grep-тест §14: файл vault.key не содержит ключа открытым текстом (ни точного
 *    keyHex, ни какой-либо 64-hex-строки);
 *  - повторный ensureKey в сессии — один decrypt / одна генерация (spy-счётчик);
 *    err-результаты не кэшируются — повтор после устранимой причины работает;
 *  - лог §18 «vault key ensured» — факт с created, без ключа;
 *  - exportKeyForBackup: возвращает wrapped-blob (§7) без расшифровки; файла нет →
 *    KEY_MISSING, файл повреждён → KEY_CORRUPT.
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
import type { EnsuredKey } from '../application/ports/key-vault.js';
import {
  SafeStorageKeyVault,
  type VaultLogger,
  type VaultSafeStorage,
} from './safe-storage-key-vault.js';

/** Момент FixedClock: createdUtc в файле детерминирован (§7). */
const NOW_MS = 1_700_000_000_000;

/** Префикс «шифротекста» мока: расшифровка без префикса = blob чужой машины/пользователя. */
const FAKE_PREFIX = 'hl-vault-test:';

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

/** Свежие spy-логгеры на тест (§18: проверяем факт и отсутствие ключа в мете). */
const makeLogger = (): { logger: VaultLogger; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } => {
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { info, warn }, info, warn };
};

describe('SafeStorageKeyVault — кейсы §13 на моке safeStorage (TASK-023 §19/§20)', () => {
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
    safeStorage: VaultSafeStorage,
    logger: VaultLogger,
  ): SafeStorageKeyVault =>
    new SafeStorageKeyVault({
      vaultFilePath: join(dir, VAULT_KEY_FILENAME),
      safeStorage,
      clock: new FixedClock(NOW_MS, 180),
      logger,
    });

  /** Путь файла ключа в каталоге (читаемость тестов). */
  const keyFile = (dir: string): string => join(dir, VAULT_KEY_FILENAME);

  /** Разобранный JSON файла ключа — как его увидит любой читатель файла (§5). */
  const readBlob = (dir: string): { v: number; wrapped: string; createdUtc: number } =>
    JSON.parse(readFileSync(keyFile(dir), 'utf8')) as { v: number; wrapped: string; createdUtc: number };

  it('кейс 1: файла нет, БД нет → ключ создан, записан, created=true (§13)', async () => {
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

    // Формат файла §5: JSON {v: 1, wrapped: base64, createdUtc}.
    const blob = readBlob(dir);
    expect(blob.v).toBe(1);
    expect(blob.createdUtc).toBe(NOW_MS);
    // wrapped действительно оборачивает ИМЕННО этот ключ (roundtrip через тот же мок).
    expect(fake.decryptString(Buffer.from(blob.wrapped, 'base64'))).toBe(ensured.keyHex);
  });

  it('кейс 2: файл есть и валиден → decrypt, created=false, ключ тот же (§13)', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    const first = makeVault(dir, new FakeSafeStorage(), logger);
    const created = unsafeUnwrap(await first.ensureKey(false));

    // Вторая сессия = новый экземпляр адаптера над тем же файлом (и тот же keyring).
    const second = makeVault(dir, new FakeSafeStorage(), logger);
    const reopened = unsafeUnwrap(await second.ensureKey(true));
    expect(reopened.created).toBe(false);
    expect(reopened.keyHex).toBe(created.keyHex);

    // dbExists при существующем файле на результат не влияет.
    const third = makeVault(dir, new FakeSafeStorage(), logger);
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

  it('кейс 3в: файл не JSON и схема не {v:1, wrapped: string, createdUtc: number} → VAULT/KEY_CORRUPT (§13)', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    const invalidPayloads: unknown[] = [
      'not-json{',
      JSON.stringify({ v: 2, wrapped: 'aaa', createdUtc: 1 }),
      JSON.stringify({ v: 1, wrapped: 42, createdUtc: 1 }),
      JSON.stringify({ v: 1, wrapped: 'aaa', createdUtc: 'не-число' }),
      JSON.stringify({ v: 1, wrapped: 'aaa' }),
      JSON.stringify({}),
    ];

    for (const payload of invalidPayloads) {
      const fresh = newDir();
      writeFileSync(keyFile(fresh), payload, 'utf8');
      const vault = makeVault(fresh, new FakeSafeStorage(), logger);
      expect(errOf(await vault.ensureKey(false)).code).toBe('VAULT/KEY_CORRUPT');
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
    writeFileSync(keyFile(dir), JSON.stringify({ v: 1, wrapped: 'aaa', createdUtc: 1 }), 'utf8');
    const readError = errOf(await vault.ensureKey(true));
    expect(readError.code).toBe('VAULT/UNAVAILABLE');
    // Доступность проверяется ДО выбора сценария: unavailable + dbExists → UNAVAILABLE, не KEY_MISSING.
    expect(fake.calls.decryptString).toBe(0);
  });

  it('grep-тест §14/§20: файл vault.key не содержит ключа открытым текстом', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    const vault = makeVault(dir, new FakeSafeStorage(), logger);
    const ensured = unsafeUnwrap(await vault.ensureKey(false));

    const content = readFileSync(keyFile(dir), 'utf8');
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
    const restoredKey = unsafeUnwrap(
      await makeVault(sourceDir, new FakeSafeStorage(), logger).ensureKey(false),
    ).keyHex;
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
    const { logger } = makeLogger();
    const vault = makeVault(dir, new FakeSafeStorage(), logger);
    unsafeUnwrap(await vault.ensureKey(false));

    const blob = unsafeUnwrap(await vault.exportKeyForBackup());
    expect(blob).toEqual({ v: 1, wrappedB64: readBlob(dir).wrapped, createdUtc: NOW_MS });

    // Пустой каталог: файла ключа нет.
    const empty = makeVault(newDir(), new FakeSafeStorage(), logger);
    expect(errOf(await empty.exportKeyForBackup()).code).toBe('VAULT/KEY_MISSING');

    // Повреждённый файл.
    const corruptDir = newDir();
    writeFileSync(keyFile(corruptDir), 'not-json{', 'utf8');
    const corrupt = makeVault(corruptDir, new FakeSafeStorage(), logger);
    expect(errOf(await corrupt.exportKeyForBackup()).code).toBe('VAULT/KEY_CORRUPT');
  });

  it('exportKeyForBackup не требует keyring: читает wrapped-blob как есть (§5: UI решит, TASK-073)', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    // Файл создан, пока keyring был доступен...
    unsafeUnwrap(await makeVault(dir, new FakeSafeStorage(), logger).ensureKey(false));

    // ...затем keyring стал недоступен — export всё равно читает wrapped-blob.
    const unavailable = new FakeSafeStorage();
    vi.spyOn(unavailable, 'isEncryptionAvailable').mockReturnValue(false);
    const vault = makeVault(dir, unavailable, logger);

    const blob = unsafeUnwrap(await vault.exportKeyForBackup());
    expect(blob.v).toBe(1);
    expect(blob.wrappedB64).toBe(readBlob(dir).wrapped);
  });

  it('тип EnsuredKey экспортируется портом: ensureKey возвращает {keyHex, created} (§5)', async () => {
    const dir = newDir();
    const { logger } = makeLogger();
    const vault = makeVault(dir, new FakeSafeStorage(), logger);

    const ensured: EnsuredKey = unsafeUnwrap(await vault.ensureKey(false));
    expect(Object.keys(ensured).sort()).toEqual(['created', 'keyHex']);
  });
});
