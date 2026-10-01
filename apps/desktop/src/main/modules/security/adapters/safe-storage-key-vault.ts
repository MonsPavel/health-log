/**
 * TASK-023 §5/§9 + TASK-093 §5: адаптер KeyVault на Electron safeStorage — обёртка
 * ключа БД средствами ОС (DPAPI на Windows / Keychain на macOS / kwallet|gnome-keyring
 * на Linux, арх. 08 §2/§7) с ДОБАТОЧНОЙ парольной обёрткой (двойная, арх. 08 §2):
 * `KEK = Argon2id(passphrase, salt)`, `wrappedKey = AES-256-GCM(dbKey, KEK)`.
 *
 * Файл ключа (§5 TASK-093): JSON v2 `{v: 2, mode: 'safeStorage'|'passphrase',
 * saltB64?, argonParams?, wrappedKeyB64, createdUtc}` (имя — vault.key, константа
 * shared; полный путь вводится зависимостью: зоны арх. 03 §4). Миграция v1→v2 —
 * при первом чтении файла (переупаковка safeStorage-blob'а, ключ не меняется);
 * downgrade v2→v1 запрещён — пишется только v2 (§13).
 *
 * Пароль (§2/§13): setPassphrase — переобёртка (БД не перешифровывается, §8);
 * changePassphrase — новая соль, параметры из файла (без рекалибровки, §15);
 * removePassphrase — возврат в safeStorage; unlock — полный derive и проверка по
 * auth-tag GCM (§5 — РЕШЕНИЕ: быстрого обхода Argon2id нет); в режиме passphrase
 * ensureKey до unlock — VAULT/LOCKED (контейнер §9 не открывает БД).
 *
 * ПРЕДУПРЕЖДЕНИЕ (§22/§13, ADR-0002): файл vault.key — единственный ключ к БД;
 * порча salt/wrappedKey в passphrase-режиме или забытый пароль = невосстановимая
 * потеря данных (та же семантика потери ключа; предупреждение UI — TASK-095).
 *
 * Зависимости вводятся конструктором (детерминированные тесты §19):
 *  - safeStorage — структурный интерфейс SafeStorageApi Electron (боевой — electron,
 *    тесты — мок); нужен только для safeStorage-режима и set/removePassphrase;
 *  - vaultFilePath — полный путь файла ключа (контейнер TASK-027 собирает join);
 *  - calibrate — фабрика параметров Argon2id (§15: по умолчанию калибровка под
 *    бюджет 500 мс; тесты подставляют быстрые параметры);
 *  - clock — источник createdUtc (SystemClock по умолчанию; тесты — FixedClock);
 *  - logger — логгер фактов (§18; боевой — createLogger('db') в контейнере).
 *
 * Логирование (§18): «vault key ensured» {created}; «vault mode changed to
 * passphrase|safeStorage» (смена режима, параметры — не секрет); «vault unlock
 * attempt» (БЕЗ пароля и результата — счётчики неудач логирует rate-limit 094);
 * отказы — warn с машинным кодом. Пароль/KEK/salt/обёртка никогда не логируются —
 * redact-список логгера страхует нарушителя (§14).
 *
 * Кэш (§13): успешный ensureKey/unlock кэшируется на жизнь экземпляра (сессия
 * разблокирована до конца процесса — §8: повторных unlock в сессии нет); err не
 * кэшируется. Обнуление строк пароля — JS-ограничение, документировано (ADR-0002).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  PASSPHRASE_SALT_BYTES,
  PassphraseWrapIntegrityError,
  calibrate as calibrateArgon2id,
  deriveKek,
  unwrapDbKey,
  wrapDbKey,
  type Argon2Params,
} from './passphrase-crypto.js';
import {
  type PassphraseVaultFile,
  type VaultKeyFileV2,
  migrateV1ToV2,
  parseV1,
  parseV2,
  serializeV2,
} from './vault-format.js';
import {
  VAULT_KEY_CORRUPT_MESSAGE_KEY,
  VAULT_KEY_MISSING_MESSAGE_KEY,
  VAULT_LOCKED_MESSAGE_KEY,
  VAULT_UNAVAILABLE_MESSAGE_KEY,
  VAULT_WRONG_PASSPHRASE_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type VaultMode,
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
  /** Логгер фактов vault-а (§18) — боевой: createLogger('db'). */
  readonly logger: VaultLogger;
  /**
   * Фабрика параметров Argon2id для setPassphrase (TASK-093 §5/§15): по умолчанию —
   * калибровка под бюджет 500 мс (однократный замер на первой установке); тесты
   * подставляют быстрые параметры (§19).
   */
  readonly calibrate?: () => Promise<Argon2Params>;
  /** Источник createdUtc; по умолчанию SystemClock (§7). */
  readonly clock?: Clock;
}

/** Ключ — ровно 64 hex-символа lowercase (инвариант §7). */
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Ключ APP/INTERNAL из контракта каркаса (contracts, app-error-dto.ts TASK-008). */
const APP_INTERNAL_MESSAGE_KEY = 'errors.internal';
const APP_NOT_IMPLEMENTED_MESSAGE_KEY = 'errors.APP_NOT_IMPLEMENTED';

/**
 * Результат чтения файла vault (с миграцией v1→v2): missing — файла нет;
 * error — программно-средовая ошибка или повреждение (готовый AppError);
 * file — валидированный v2-файл (v1 переупакован на диске, §5).
 */
type VaultFileState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly error: AppError }
  | { readonly kind: 'file'; readonly file: VaultKeyFileV2 };

/** true, если ошибка — Node-ошибка с данным кодом (например, ENOENT: файла нет). */
function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: string } | null)?.code === code;
}

/** Адаптер KeyVault на safeStorage + двойная парольная обёртка (§5 TASK-093). */
export class SafeStorageKeyVault implements KeyVault {
  private readonly vaultFilePath: string;
  private readonly safeStorage: VaultSafeStorage;
  private readonly logger: VaultLogger;
  private readonly calibrate: () => Promise<Argon2Params>;
  private readonly clock: Clock;

  /** Кэш успешного ensureKey/unlock (§13: один decrypt за старт; сессия разблокирована). */
  private cached?: Result<EnsuredKey, AppError>;
  /** Летящий ensureKey: параллельные вызовы делят один сценарий генерации/расшифровки. */
  private pending?: Promise<Result<EnsuredKey, AppError>>;

  constructor(options: SafeStorageKeyVaultOptions) {
    this.vaultFilePath = options.vaultFilePath;
    this.safeStorage = options.safeStorage;
    this.logger = options.logger;
    this.calibrate = options.calibrate ?? calibrateArgon2id;
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

  /** §5: wrapped-ключ как есть — без keyring и расшифровки (см. порт; passphrase → отказ). */
  async exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    const state = await this.readVaultFile();
    if (state.kind === 'missing') {
      return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
    }
    if (state.kind === 'error') {
      return this.failWith(state.error);
    }
    if (state.file.mode === 'passphrase') {
      // §5 TASK-093: резервный ключ в passphrase-режиме невосстановим без пароля —
      // семантика восстановления не определена до TASK-094/101: явный отказ, не blob.
      return this.fail('APP/NOT_IMPLEMENTED', APP_NOT_IMPLEMENTED_MESSAGE_KEY, {
        reason: 'backup-of-passphrase-vault',
      });
    }
    return ok({ v: 2, wrappedB64: state.file.wrappedKeyB64, createdUtc: state.file.createdUtc });
  }

  /** TASK-093 §5/§13: включение пароля — переобёртка файла (см. порт). */
  async setPassphrase(passphrase: string): Promise<Result<void, AppError>> {
    const state = await this.readVaultFile();
    if (state.kind === 'missing') {
      return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
    }
    if (state.kind === 'error') {
      return this.failWith(state.error);
    }
    if (state.file.mode === 'passphrase') {
      // Контракт §5: пароль уже включён — смена через changePassphrase.
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, {
        reason: 'passphrase-already-set',
      });
    }
    const key = await this.resolveCurrentKey(state.file);
    if (!key.ok) {
      return key;
    }
    const params = await this.calibrate();
    const wrapped = await this.wrapWithPassphrase(
      key.value,
      passphrase,
      params,
      state.file.createdUtc,
    );
    if (!wrapped.ok) {
      return this.failWith(wrapped.error);
    }
    this.logger.info('vault mode changed to passphrase', {
      iterations: params.iterations,
      memoryKib: params.memoryKib,
      parallelism: params.parallelism,
    });
    return ok(undefined);
  }

  /** TASK-093 §5/§13: смена пароля — verify(old) → переобёртка с новой солью (см. порт). */
  async changePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
  ): Promise<Result<void, AppError>> {
    const state = await this.readVaultFile();
    if (state.kind === 'missing') {
      return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
    }
    if (state.kind === 'error') {
      return this.failWith(state.error);
    }
    if (state.file.mode !== 'passphrase') {
      // Контракт §5: пароля нет — включение через setPassphrase.
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, {
        reason: 'passphrase-not-set',
      });
    }
    const key = await this.openWithPassphrase(state.file, oldPassphrase);
    if (!key.ok) {
      return key;
    }
    // §15: параметры — из файла (рекалибровки нет); соль — всегда новая.
    const wrapped = await this.wrapWithPassphrase(
      key.value,
      newPassphrase,
      state.file.argonParams,
      state.file.createdUtc,
    );
    if (!wrapped.ok) {
      return this.failWith(wrapped.error);
    }
    return ok(undefined);
  }

  /** TASK-093 §5/§13: снятие пароля → возврат в mode='safeStorage' (см. порт). */
  async removePassphrase(oldPassphrase: string): Promise<Result<void, AppError>> {
    const state = await this.readVaultFile();
    if (state.kind === 'missing') {
      return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
    }
    if (state.kind === 'error') {
      return this.failWith(state.error);
    }
    if (state.file.mode !== 'passphrase') {
      return ok(undefined); // идемпотентно: пароля нет
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return this.fail('VAULT/UNAVAILABLE', VAULT_UNAVAILABLE_MESSAGE_KEY, {
        platform: process.platform,
      });
    }
    const key = await this.openWithPassphrase(state.file, oldPassphrase);
    if (!key.ok) {
      return key;
    }
    try {
      const wrappedB64 = this.safeStorage.encryptString(key.value).toString('base64');
      await this.writeVaultFile({
        v: 2,
        mode: 'safeStorage',
        wrappedKeyB64: wrappedB64,
        createdUtc: state.file.createdUtc,
      });
    } catch (error) {
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
    }
    this.logger.info('vault mode changed to safeStorage');
    return ok(undefined);
  }

  /** TASK-093 §5/§9: разблокировка — derive KEK + проверка по auth-tag GCM (см. порт). */
  async unlock(passphrase: string): Promise<Result<void, AppError>> {
    if (this.cached?.ok === true) {
      return ok(undefined); // сессия уже разблокирована (§13)
    }
    const state = await this.readVaultFile();
    if (state.kind === 'missing') {
      return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
    }
    if (state.kind === 'error') {
      return this.failWith(state.error);
    }
    if (state.file.mode !== 'passphrase') {
      return ok(undefined); // идемпотентно: заблокировано ничего не было
    }
    // §18: сам факт попытки — без пароля; исход (ok/err) и счётчики — TASK-094.
    this.logger.info('vault unlock attempt');
    const key = await this.openWithPassphrase(state.file, passphrase);
    if (!key.ok) {
      return key;
    }
    // Сессия разблокирована: ключ доступен ensureKey («unlock → ensureKey → БД», §9).
    this.cached = ok({ keyHex: key.value, created: false });
    return ok(undefined);
  }

  /** TASK-093 §7: режим vault-а из заголовка файла — синхронно, без crypto (см. порт). */
  getMode(): VaultMode {
    let raw: string;
    try {
      raw = readFileSync(this.vaultFilePath, 'utf8');
    } catch {
      return 'none'; // файла нет (или не читается — вскроется при обращении, §13)
    }
    const file = parseV2(raw);
    return file?.mode === 'passphrase' ? 'passphrase' : 'none';
  }

  /**
   * Читает файл vault с миграцией v1→v2 при старте (§5): v1 переупаковывается в v2
   * НА ДИСКЕ (safeStorage-blob и createdUtc сохраняются — ключ не меняется); любое
   * отклонение схемы — KEY_CORRUPT (§13), прочие ошибки чтения/записи — APP/INTERNAL.
   */
  private async readVaultFile(): Promise<VaultFileState> {
    let raw: string;
    try {
      raw = await readFile(this.vaultFilePath, 'utf8');
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) {
        return { kind: 'missing' };
      }
      return {
        kind: 'error',
        error: AppError.of('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error),
      };
    }
    const file = parseV2(raw);
    if (file !== undefined) {
      return { kind: 'file', file };
    }
    const legacy = parseV1(raw);
    if (legacy !== undefined) {
      const migrated = migrateV1ToV2(legacy);
      try {
        await this.writeVaultFile(migrated);
      } catch (error) {
        return {
          kind: 'error',
          error: AppError.of('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error),
        };
      }
      this.logger.info('vault key format migrated to v2', { mode: migrated.mode });
      return { kind: 'file', file: migrated };
    }
    return {
      kind: 'error',
      error: AppError.of(
        'VAULT/KEY_CORRUPT',
        VAULT_KEY_CORRUPT_MESSAGE_KEY,
        undefined,
        'файл vault.key не соответствует формату v1 {v, wrapped, createdUtc} или v2 {v, mode, wrappedKeyB64, createdUtc, …}',
      ),
    };
  }

  /** Один прогон сценария ensureKey (§13 1–5 + LOCKED; кэширование — в ensureKey). */
  private async ensureKeyUncached(dbExists: boolean): Promise<Result<EnsuredKey, AppError>> {
    const state = await this.readVaultFile();

    if (state.kind === 'error') {
      // Файл есть, но повреждён/не читается — кейс 3 (§13).
      return this.failWith(state.error);
    }
    if (state.kind === 'missing') {
      if (dbExists) {
        // Кейс 4 (§13/§20): файла ключа нет при существующей БД — новый ключ НЕ
        // генерируется (это молчаливая потеря всех данных) — явный KEY_MISSING.
        return this.fail('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY);
      }
      // Кейс 1 (§13): первая установка — ключ создаётся здесь и только здесь.
      return this.generateAndStore();
    }
    if (state.file.mode === 'passphrase') {
      // TASK-093 §9/§13: до unlock ключа нет — контейнер не открывает БД (LOCKED).
      if (this.cached?.ok === true) {
        return this.cached; // сессия уже разблокирована (после unlock)
      }
      return this.fail('VAULT/LOCKED', VAULT_LOCKED_MESSAGE_KEY);
    }
    // Кейсы 2/3 (§13): safeStorage-режим — расшифровка.
    return this.unwrapSafeStorageKey(state.file);
  }

  /** Кейс 1 (§13): CSPRNG-ключ → safeStorage → запись v2 → created=true (§14). */
  private async generateAndStore(): Promise<Result<EnsuredKey, AppError>> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return this.fail('VAULT/UNAVAILABLE', VAULT_UNAVAILABLE_MESSAGE_KEY, {
        platform: process.platform,
      });
    }
    const keyHex = randomBytes(32).toString('hex');
    const createdUtc = this.clock.nowMs();
    try {
      const wrappedKeyB64 = this.safeStorage.encryptString(keyHex).toString('base64');
      await this.writeVaultFile({
        v: 2,
        mode: 'safeStorage',
        wrappedKeyB64,
        createdUtc,
      });
    } catch (error) {
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
    }
    this.logger.info('vault key ensured', { created: true });
    return ok({ keyHex, created: true });
  }

  /** Кейсы 2/3 (§13): safeStorage-расшифровка v2-файла; любой сбой — VAULT/KEY_CORRUPT. */
  private async unwrapSafeStorageKey(file: VaultKeyFileV2): Promise<Result<EnsuredKey, AppError>> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return this.fail('VAULT/UNAVAILABLE', VAULT_UNAVAILABLE_MESSAGE_KEY, {
        platform: process.platform,
      });
    }
    let keyHex: string;
    try {
      keyHex = this.safeStorage.decryptString(Buffer.from(file.wrappedKeyB64, 'base64'));
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

  /**
   * Ключ текущей установки для setPassphrase (§13 «при открытой БД — мгновенно»):
   * из кэша сессии (боевой поток: ensureKey уже отработал) или safeStorage-расшифровкой.
   */
  private async resolveCurrentKey(file: VaultKeyFileV2): Promise<Result<string, AppError>> {
    if (this.cached?.ok === true) {
      return ok(this.cached.value.keyHex);
    }
    const unwrapped = await this.unwrapSafeStorageKey(file);
    if (unwrapped.ok) {
      this.cached = unwrapped; // сессия имела право на ключ — кэшируем (§13)
      return ok(unwrapped.value.keyHex);
    }
    return err(unwrapped.error);
  }

  /**
   * Полный derive KEK и разворачивание ключа (TASK-093 §2): сбой auth-tag →
   * VAULT/WRONG_PASSPHRASE (неверный пароль); прочее — APP/INTERNAL. Верификация
   * происходит БЕЗ открытия БД и БЕЗ safeStorage (§20).
   */
  private async openWithPassphrase(
    file: PassphraseVaultFile,
    passphrase: string,
  ): Promise<Result<string, AppError>> {
    const salt = Buffer.from(file.saltB64, 'base64');
    let kek: Buffer;
    try {
      kek = await deriveKek(passphrase, salt, file.argonParams);
    } catch (error) {
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
    }
    let keyBytes: Buffer;
    try {
      keyBytes = unwrapDbKey(Buffer.from(file.wrappedKeyB64, 'base64'), kek);
    } catch (error) {
      if (error instanceof PassphraseWrapIntegrityError) {
        // §2/§19: неверный пароль (или подмена/порча байтов при валидной схеме —
        // криптографически неотличимо, §14 backup-crypto).
        return this.fail('VAULT/WRONG_PASSPHRASE', VAULT_WRONG_PASSPHRASE_MESSAGE_KEY);
      }
      return this.fail('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
    }
    const keyHex = keyBytes.toString('hex');
    if (!KEY_HEX_PATTERN.test(keyHex)) {
      // GCM-целостность нарушена быть не могла — файл создан в чужом формате.
      return this.fail(
        'VAULT/KEY_CORRUPT',
        VAULT_KEY_CORRUPT_MESSAGE_KEY,
        undefined,
        'развёрнутый текст не является 64-hex-ключом (32 байта)',
      );
    }
    return ok(keyHex);
  }

  /** Переобёртка ключа паролем: соль → KEK → GCM → запись v2 passphrase (§2/§5). */
  private async wrapWithPassphrase(
    keyHex: string,
    passphrase: string,
    params: Argon2Params,
    createdUtc: number,
  ): Promise<Result<void, AppError>> {
    const salt = randomBytes(PASSPHRASE_SALT_BYTES);
    try {
      const kek = await deriveKek(passphrase, salt, params);
      const wrapped = wrapDbKey(Buffer.from(keyHex, 'hex'), kek);
      await this.writeVaultFile({
        v: 2,
        mode: 'passphrase',
        wrappedKeyB64: wrapped.toString('base64'),
        createdUtc,
        saltB64: salt.toString('base64'),
        argonParams: params,
      });
      return ok(undefined);
    } catch (error) {
      return err(AppError.of('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error));
    }
  }

  /** Атомарная по смыслу запись файла (§5; формат — только v2, downgrade запрещён §13). */
  private async writeVaultFile(file: VaultKeyFileV2): Promise<void> {
    await writeFile(this.vaultFilePath, serializeV2(file), 'utf8');
  }

  /** Ошибка сценария ensureKey/export: warn-лог с машинным кодом (§18) + err. */
  private fail(
    code: ErrorCode,
    messageKey: string,
    params?: AppErrorParams,
    cause?: unknown,
  ): Result<never, AppError> {
    this.logger.warn('vault key ensure failed', { code });
    return err(AppError.of(code, messageKey, params, cause));
  }

  /** Ошибка, уже собранная как AppError (чтение файла/переобёртка) — warn + наружу. */
  private failWith(error: AppError): Result<never, AppError> {
    this.logger.warn('vault key ensure failed', { code: error.code });
    return err(error);
  }
}
