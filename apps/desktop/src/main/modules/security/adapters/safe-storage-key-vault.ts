/**
 * TASK-023 §5/§9: адаптер KeyVault на Electron safeStorage — обёртка ключа БД
 * средствами ОС (DPAPI на Windows / Keychain на macOS / kwallet|gnome-keyring на Linux,
 * арх. 08 §2/§7): ноль своего крипто-кода, keytar не используется (устарел).
 *
 * Файл ключа (§5): `<vaultFilePath>` = JSON `{v: 1, wrapped: base64, createdUtc}`
 * (имя файла — vault.key, константа в shared; полный путь вводится зависимостью:
 * зоны арх. 03 §4 — adapters не импортируют shared, контейнер TASK-027 собирает
 * `join(app.getPath('userData'), VAULT_KEY_FILENAME)`).
 *
 * ПРЕДУПРЕЖДЕНИЕ (§22, ADR-0002): файл vault.key — единственный ключ к БД. Его потеря
 * при существующей БД = невосстановимая потеря данных (VAULT/KEY_MISSING → предложение
 * восстановиться из копии, TASK-101/071). Перенос файла на другую машину бессмыслен:
 * DPAPI привязывает обёртку к пользователю Windows (это фича — ключ не крадётся вместе
 * с файлом), при смене пользователя/машины — VAULT/KEY_CORRUPT (§13 кейс 3).
 *
 * Зависимости вводятся конструктором (детерминированные тесты §19):
 *  - safeStorage — структурный интерфейс SafeStorageApi Electron (isEncryptionAvailable/
 *    encryptString/decryptString); боевой — safeStorage из electron, в тестах — мок;
 *  - vaultFilePath — полный путь файла ключа (см. выше);
 *  - clock — источник createdUtc (SystemClock по умолчанию; в тестах FixedClock);
 *  - logger — логгер факта ensureKey (§18; боевой — createLogger('db') в контейнере).
 *
 * Логирование (§18): только факт «vault key ensured» с флагом created (без ключа —
 * redact-список логгера keyHex/wrapped/wrappedB64 страхует нарушение правила вызова)
 * и «vault key ensure failed» с машинным кодом ошибки. Сообщения ключей пользователю —
 * TASK-095/101 (§16–17).
 *
 * Кэш (§13): успешный ensureKey кэшируется на жизнь экземпляра (один decrypt за старт —
 * контейнер создаёт vault один раз на сессию); err-результаты не кэшируются — повторный
 * вызов после устранимой причины (восстановление файла из копии) работает.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  AppError,
  SystemClock,
  err,
  ok,
  type AppErrorParams,
  type Clock,
  type ErrorCode,
  type Result,
} from '@hl/kernel';

import {
  VAULT_KEY_CORRUPT_MESSAGE_KEY,
  VAULT_KEY_MISSING_MESSAGE_KEY,
  VAULT_UNAVAILABLE_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../application/ports/key-vault.js';

/**
 * Структурный интерфейс safeStorage (§19: мок — encrypt/decryptString/isEncryptionAvailable).
 * Реальный Electron.SafeStorageApi ему структурно соответствует.
 */
export interface VaultSafeStorage {
  /** true — шифрование ОС-хранилища доступно (Linux без keyring → false, §4/§22). */
  isEncryptionAvailable(): boolean;
  /** Шифрует открытый текст ключом ОС-хранилища; возвращает обёртку (байты). */
  encryptString(plainText: string): Buffer;
  /** Расшифровывает обёртку; падает/даёт мусор, если blob чужой (кейс 3, §13). */
  decryptString(encrypted: Buffer): string;
}

/** Логгер адаптера (§18): структурное подмножество HlLogger (arch-матрица: adapters не импортируют shared). */
export interface VaultLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Опции конструктора адаптера (см. шапку: все зависимости вводятся снаружи). */
export interface SafeStorageKeyVaultOptions {
  /** Полный путь файла ключа: `<userData>/vault.key` (собирает контейнер, TASK-027). */
  readonly vaultFilePath: string;
  /** SafeStorageApi Electron (боевой) или мок (тесты, §19). */
  readonly safeStorage: VaultSafeStorage;
  /** Логгер факта ensureKey (§18) — боевой: createLogger('db'). */
  readonly logger: VaultLogger;
  /** Источник createdUtc; по умолчанию SystemClock (§7). */
  readonly clock?: Clock;
}

/** JSON-форма файла ключа на диске (§5) до валидации схемы. */
interface VaultKeyFileJson {
  readonly v?: unknown;
  readonly wrapped?: unknown;
  readonly createdUtc?: unknown;
}

/** Валидированное содержимое файла (§5 после разбора). */
interface ParsedVaultFile {
  readonly wrapped: string;
  readonly createdUtc: number;
}

/** Версия формата файла ключа (§5: v = 1). */
const FORMAT_VERSION = 1;

/** Размер ключа БД в байтах (§7: 32 байта → hex 64 символа lowercase). */
const KEY_BYTES = 32;

/** Ключ — ровно 64 hex-символа lowercase (инвариант §7). */
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Ключ APP/INTERNAL из контракта каркаса (contracts, app-error-dto.ts TASK-008). */
const APP_INTERNAL_MESSAGE_KEY = 'errors.internal';

/** true, если ошибка — Node-ошибка с данным кодом (например, ENOENT: файла нет). */
function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: string } | null)?.code === code;
}

/**
 * Разбор и валидация файла ключа (§5): JSON-объект `{v: 1, wrapped: non-empty string,
 * createdUtc: finite number}`. Любое отклонение — undefined (→ VAULT/KEY_CORRUPT,
 * кейс 3 §13: «файл есть и валиден» — иначе он считается повреждённым).
 */
function parseVaultFile(raw: string): ParsedVaultFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const file = parsed as VaultKeyFileJson;
  if (file.v !== FORMAT_VERSION) {
    return undefined;
  }
  if (typeof file.wrapped !== 'string' || file.wrapped.length === 0) {
    return undefined;
  }
  if (typeof file.createdUtc !== 'number' || !Number.isFinite(file.createdUtc)) {
    return undefined;
  }
  return { wrapped: file.wrapped, createdUtc: file.createdUtc };
}

/** Адаптер KeyVault на safeStorage (§5). Поведение ensureKey — см. порт KeyVault. */
export class SafeStorageKeyVault implements KeyVault {
  private readonly vaultFilePath: string;
  private readonly safeStorage: VaultSafeStorage;
  private readonly logger: VaultLogger;
  private readonly clock: Clock;

  /** Кэш успешного ensureKey (§13: один decrypt за старт). */
  private cached?: Result<EnsuredKey, AppError>;
  /** Летящий ensureKey: параллельные вызовы делят один сценарий генерации/расшифровки. */
  private pending?: Promise<Result<EnsuredKey, AppError>>;

  constructor(options: SafeStorageKeyVaultOptions) {
    this.vaultFilePath = options.vaultFilePath;
    this.safeStorage = options.safeStorage;
    this.logger = options.logger;
    this.clock = options.clock ?? new SystemClock();
  }

  /** §13: кэш успеха; летящий вызов переиспользуется; err не кэшируется (см. шапку). */
  async ensureKey(dbExists: boolean): Promise<Result<EnsuredKey, AppError>> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    this.pending ??= this.ensureKeyUncached(dbExists)
      .then((result) => {
        if (result.ok) {
          this.cached = result;
        }
        return result;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  /** §5: wrapped-ключ как есть — без keyring и расшифровки (см. порт). */
  async exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.vaultFilePath, 'utf8');
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) {
        return err(AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY));
      }
      return err(AppError.of('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error));
    }
    const parsed = parseVaultFile(raw);
    if (parsed === undefined) {
      return err(
        AppError.of(
          'VAULT/KEY_CORRUPT',
          VAULT_KEY_CORRUPT_MESSAGE_KEY,
          undefined,
          'файл vault.key не соответствует формату {v: 1, wrapped, createdUtc}',
        ),
      );
    }
    return ok({ v: FORMAT_VERSION, wrappedB64: parsed.wrapped, createdUtc: parsed.createdUtc });
  }

  /** Один прогон сценария ensureKey (кейсы §13 1–5; кэширование — в ensureKey). */
  private async ensureKeyUncached(dbExists: boolean): Promise<Result<EnsuredKey, AppError>> {
    // Кейс 5 (§13): без шифрования ОС-хранилища не выполнимы ни создание, ни расшифровка —
    // проверка ДО выбора сценария (unavailable + dbExists=true → UNAVAILABLE, не KEY_MISSING).
    if (!this.safeStorage.isEncryptionAvailable()) {
      return this.fail(
        'VAULT/UNAVAILABLE',
        VAULT_UNAVAILABLE_MESSAGE_KEY,
        // Платформенное пояснение (§5): имя платформы без пользовательских данных.
        { platform: process.platform },
      );
    }

    let raw: string;
    try {
      raw = await readFile(this.vaultFilePath, 'utf8');
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) {
        // Файл есть, но не читается (права/диск) — программно-средовая ошибка, не сценарий §13.
        return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
      }
      if (dbExists) {
        // Кейс 4 (§13/§20): файла ключа нет при существующей БД — новый ключ НЕ
        // генерируется (это молчаливая потеря всех данных) — явный KEY_MISSING.
        return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
      }
      // Кейс 1 (§13): первая установка — ключ создаётся здесь и только здесь.
      return this.generateAndStore();
    }

    // Кейсы 2/3 (§13): файл есть — расшифровка.
    return this.unwrapStoredKey(raw);
  }

  /** Кейс 1 (§13): CSPRNG-ключ → encryptString → запись файла → created=true (§14). */
  private async generateAndStore(): Promise<Result<EnsuredKey, AppError>> {
    const keyHex = randomBytes(KEY_BYTES).toString('hex');
    const createdUtc = this.clock.nowMs();
    try {
      const wrapped = this.safeStorage.encryptString(keyHex).toString('base64');
      const fileJson = JSON.stringify({ v: FORMAT_VERSION, wrapped, createdUtc });
      await writeFile(this.vaultFilePath, fileJson, 'utf8');
    } catch (error) {
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
    }
    this.logger.info('vault key ensured', { created: true });
    return ok({ keyHex, created: true });
  }

  /** Кейсы 2/3 (§13): расшифровка файла; любой сбой — VAULT/KEY_CORRUPT. */
  private unwrapStoredKey(raw: string): Result<EnsuredKey, AppError> {
    const parsed = parseVaultFile(raw);
    if (parsed === undefined) {
      return this.fail(
        'VAULT/KEY_CORRUPT',
        VAULT_KEY_CORRUPT_MESSAGE_KEY,
        undefined,
        'файл vault.key не соответствует формату {v: 1, wrapped, createdUtc}',
      );
    }
    let keyHex: string;
    try {
      keyHex = this.safeStorage.decryptString(Buffer.from(parsed.wrapped, 'base64'));
    } catch (error) {
      // Кейс 3 (§13): сменился Windows-пользователь/машина — keyring не может расшифровать.
      return this.fail('VAULT/KEY_CORRUPT', VAULT_KEY_CORRUPT_MESSAGE_KEY, undefined, error);
    }
    if (!KEY_HEX_PATTERN.test(keyHex)) {
      // Кейс 3 (§13): расшифровался мусор — ключом это быть не может.
      return this.fail(
        'VAULT/KEY_CORRUPT',
        VAULT_KEY_CORRUPT_MESSAGE_KEY,
        undefined,
        'расшифрованный текст не является 64-hex-ключом (32 байта)',
      );
    }
    this.logger.info('vault key ensured', { created: false });
    return ok({ keyHex, created: false });
  }

  /** Ошибка сценария: warn-лог с машинным кодом (§18) + err-Result с AppError. */
  private fail(
    code: ErrorCode,
    messageKey: string,
    params?: AppErrorParams,
    cause?: unknown,
  ): Result<never, AppError> {
    this.logger.warn('vault key ensure failed', { code });
    return err(AppError.of(code, messageKey, params, cause));
  }
}
