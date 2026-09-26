/**
 * TASK-023 §5/§7: порт KeyVault — хранилище ключа БД (модуль security, арх. 02 §5:
 * порты — application-слой; реализация — адаптер SafeStorageKeyVault).
 *
 * Сигнатуры §5 с двумя уточняющими трактовками (документировано в summary TASK-023;
 * прецедент — Result у мутаций репозитория, TASK-021):
 *  1. `ensureKey(dbExists)` — §13 кейс 4: «файла нет после того, как БД существует →
 *     VAULT/KEY_MISSING (не генерировать новый!)» требует параметра dbExists —
 *     различение по наличию файла БД (решает вызывающий, контейнер TASK-027);
 *  2. `Promise<Result<...>>` вместо `Promise<...>` — кейсы §13/§20 (KEY_MISSING,
 *     KEY_CORRUPT, UNAVAILABLE) — предсказуемые исходы сценария «потеря ключа» (§3),
 *     ошибки доставляются значением, исключения не пересекают слои (арх. 02 §5).
 *
 * Безопасность (§14): keyHex никогда не логируется, не передаётся в renderer, не пишется
 * открытым текстом (wrapped через safeStorage — DPAPI/Keychain, арх. 08 §2); redact-список
 * логгера покрывает keyHex/wrapped/wrappedB64 (TASK-022/023).
 */
import { AppError, type Result } from '@hl/kernel';

/**
 * Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`);
 * тексты — TASK-095/101 (§16–17: коды стабильны с этого момента).
 */
export const VAULT_KEY_MISSING_MESSAGE_KEY = 'errors.VAULT_KEY_MISSING';
export const VAULT_KEY_CORRUPT_MESSAGE_KEY = 'errors.VAULT_KEY_CORRUPT';
export const VAULT_UNAVAILABLE_MESSAGE_KEY = 'errors.VAULT_UNAVAILABLE';

/** Результат ensureKey (§5/§7): hex-ключ + флаг «хранилище создано» (лог/онбординг). */
export interface EnsuredKey {
  /** Ключ БД: 32 байта, 64 hex-символа lowercase (инвариант §7). */
  readonly keyHex: string;
  /** true — ключ сгенерирован и записан при этом вызове («хранилище создано», §7). */
  readonly created: boolean;
}

/** Wrapped-ключ для резервной копии (§7): тот же формат, что и файл vault.key (§5). */
export interface WrappedKeyBlob {
  /** Версия формата (§5: v = 1). */
  readonly v: 1;
  /** Обёртка ключа (safeStorage), base64 — расшифровка возможна только на той же машине/пользователе. */
  readonly wrappedB64: string;
  /** Момент создания ключа, мс эпохи Unix (§7: createdUtc: number). */
  readonly createdUtc: number;
}

/** Порт хранилища ключа БД (§5). Реализация — SafeStorageKeyVault (adapters). */
export interface KeyVault {
  /**
   * Гарантирует наличие ключа и возвращает его (§13):
   *  - файла нет, dbExists=false → сгенерировать, записать, created=true (кейс 1);
   *  - файл есть и валиден → расшифровать, created=false (кейс 2);
   *  - файл есть, расшифровать нельзя / повреждён → err VAULT/KEY_CORRUPT (кейс 3);
   *  - файла нет, dbExists=true → err VAULT/KEY_MISSING — НЕ генерировать новый (кейс 4);
   *  - шифрование ОС-хранилища недоступно → err VAULT/UNAVAILABLE (кейс 5).
   * Повторный вызов в сессии возвращает кэшированный успех (§13: один decrypt за старт);
   * err-результаты не кэшируются — повтор после устранимой причины (восстановление из
   * копии, TASK-101) работает.
   */
  ensureKey(dbExists: boolean): Promise<Result<EnsuredKey, AppError>>;

  /**
   * Возвращает wrapped-ключ как есть (§5): резервная копия восстанавливается только
   * на той же машине/пользователе ОС. Keyring не требуется — расшифровки нет.
   * Файла нет → err VAULT/KEY_MISSING; файл повреждён → err VAULT/KEY_CORRUPT.
   * Показ копии пользователю решит UI (TASK-073; MVP: не показываем, §5).
   */
  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>>;
}
