/**
 * TASK-023 §5/§7 + TASK-093 §5/§7: порт KeyVault — хранилище ключа БД (модуль
 * security, арх. 02 §5: порты — application-слой; реализация — SafeStorageKeyVault).
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
 * TASK-093 (аддитивно, §7): двойная обёртка паролем — setPassphrase/changePassphrase/
 * removePassphrase/unlock + getMode. Смена/снятие пароля = переобёртка файла (БД не
 * перешифровывается, §8); неверный пароль детектируется по auth-tag GCM БЕЗ открытия
 * БД (§2). Пароль — min 8 на стороне UI (TASK-095, §14 «крипто-агностик»).
 *
 * Безопасность (§14): keyHex/passphrase никогда не логируются, не передаются в
 * renderer, не пишутся открытым текстом; redact-список логгера покрывает keyHex/
 * wrapped/wrappedB64/wrappedKey/salt/saltB64/passphrase (TASK-022/023/093).
 */
import { AppError, type Result } from '@hl/kernel';

/**
 * Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`);
 * тексты — TASK-095/101 (§16–17: коды стабильны с этого момента).
 * VAULT_LOCKED_MESSAGE_KEY с TASK-094 живёт в contracts (vault.ts — единый источник
 * для гвардии requireUnlocked каркаса, §7/§11) и отсюда реэкспортируется.
 */
export const VAULT_KEY_MISSING_MESSAGE_KEY = 'errors.VAULT_KEY_MISSING';
export const VAULT_KEY_CORRUPT_MESSAGE_KEY = 'errors.VAULT_KEY_CORRUPT';
export const VAULT_UNAVAILABLE_MESSAGE_KEY = 'errors.VAULT_UNAVAILABLE';
export const VAULT_WRONG_PASSPHRASE_MESSAGE_KEY = 'errors.VAULT_WRONG_PASSPHRASE';
import { VAULT_LOCKED_MESSAGE_KEY } from '@hl/contracts';
export { VAULT_LOCKED_MESSAGE_KEY };

/**
 * Режим vault-а для потребителя порта (TASK-093 §7: getMode(): 'none'|'passphrase'):
 * 'none' — разблокировка автоматична (нет пароля: файла нет / v2 mode=safeStorage);
 * 'passphrase' — запуск требует unlock(pass) (§9: контейнер не открывает БД до unlock).
 */
export type VaultMode = 'none' | 'passphrase';

/** Результат ensureKey (§5/§7): hex-ключ + флаг «хранилище создано» (лог/онбординг). */
export interface EnsuredKey {
  /** Ключ БД: 32 байта, 64 hex-символа lowercase (инвариант §7). */
  readonly keyHex: string;
  /** true — ключ сгенерирован и записан при этом вызове («хранилище создано», §7). */
  readonly created: boolean;
}

/**
 * Wrapped-ключ для резервной копии (§7): та же safeStorage-обёртка, что в файле
 * vault.key v2 (§5) — восстанавливается только на той же машине/пользователе ОС.
 * В режиме passphrase резервная копия ключа не выдаётся (см. exportKeyForBackup).
 */
export interface WrappedKeyBlob {
  /** Версия формата файла-источника (TASK-093 §5: v = 2). */
  readonly v: 2;
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
   *  - шифрование ОС-хранилища недоступно → err VAULT/UNAVAILABLE (кейс 5);
   *  - режим passphrase и unlock ещё не был → err VAULT/LOCKED (TASK-093 §9/§12:
   *    БД не открывается до unlock; снятие состояния — TASK-094).
   * Повторный вызов в сессии возвращает кэшированный успех (§13: один decrypt за старт);
   * err-результаты не кэшируются — повтор после устранимой причины (unlock,
   * восстановление из копии, TASK-101) работает.
   */
  ensureKey(dbExists: boolean): Promise<Result<EnsuredKey, AppError>>;

  /**
   * Возвращает wrapped-ключ как есть (§5): резервная копия восстанавливается только
   * на той же машине/пользователе ОС. Keyring не требуется — расшифровки нет.
   * Файла нет → err VAULT/KEY_MISSING; файл повреждён → err VAULT/KEY_CORRUPT;
   * режим passphrase → err APP/NOT_IMPLEMENTED (TASK-093 §5: семантика резервного
   * копирования vault-а с паролем не определена до TASK-094/101 — явный отказ, не
   * молчаливый невосстановимый blob).
   * Показ копии пользователю решит UI (TASK-073; MVP: не показываем, §5).
   */
  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>>;

  /**
   * TASK-093 §5/§13: включает пароль — ключ БД дополнительно оборачивается
   * (`KEK = Argon2id(pass, salt)`, `wrappedKey = AES-256-GCM(dbKey, KEK)`), файл
   * переводится в mode='passphrase'. Мгновенно при открытой БД (переобёртка, §13);
   * БД не перешифровывается (§8) — текущая сессия продолжает работать, последующие
   * старты требуют unlock. Калибровка Argon2id — однократно здесь (§15), параметры
   * сохраняются в файле. Файла нет → VAULT/KEY_MISSING; уже passphrase → отказ
   * (вызывающий должен звать changePassphrase); нет ключа/доступа к safeStorage →
   * VAULT/UNAVAILABLE. Пароль min 8 — политика UI (TASK-095, §14).
   */
  setPassphrase(passphrase: string): Promise<Result<void, AppError>>;

  /**
   * TASK-093 §5/§13: смена пароля = переобёртка (новая соль, те же argonParams из
   * файла — без рекалибровки, §15); dbKey не меняется (БД не перешифровывается —
   * инвариант §7). Неверный old → err VAULT/WRONG_PASSPHRASE (auth-tag GCM, БД не
   * открывается); не passphrase-режим → отказ; salt/wrapped повреждены →
   * VAULT/KEY_CORRUPT (данные невосстановимы — семантика потери ключа, §13).
   */
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<Result<void, AppError>>;

  /**
   * TASK-093 §5/§13: снятие пароля → возврат в mode='safeStorage' (safeStorage-
   * переобёртка того же dbKey; БД не перешифровывается). Неверный old →
   * VAULT/WRONG_PASSPHRASE; safeStorage недоступен → VAULT/UNAVAILABLE;
   * уже 'none' → ok (идемпотентно).
   */
  removePassphrase(oldPassphrase: string): Promise<Result<void, AppError>>;

  /**
   * TASK-093 §5/§9: разблокировка — полный derive KEK и проверка по auth-tag GCM;
   * успех → ключ доступен ensureKey (поток «unlock → ensureKey → открытие БД», §9).
   * Неверный пароль → err VAULT/WRONG_PASSPHRASE (повтор разрешён; rate-limit —
   * TASK-094); порча salt/wrapped → VAULT/KEY_CORRUPT; режима passphrase нет →
   * ok (ничего не заблокировано — идемпотентен); повторный unlock → ok (кэш §13 —
   * пока не было lock() ниже).
   */
  unlock(passphrase: string): Promise<Result<void, AppError>>;

  /**
   * TASK-094 §5/§8: блокировка хранилища — сброс сессионного кэша ключа (093 §13):
   * последующие ensureKey/unlock НЕ считают сессию разблокированной — ensureKey
   * снова VAULT/LOCKED, а unlock(pass) обязан ПОЛНОСТЬЮ проверить пароль по файлу
   * (путь «повторный unlock открывает», §5). Без этого кэш переживал бы lock и
   * unlock с ЛЮБЫМ паролем возвращал бы ok — парольная защита повторного входа
   * была бы фикцией. mode=none — no-op по эффекту на вызывающих (ensureKey
   * перевыполнит safeStorage-расшифровку из файла). Вызывает VaultService.lock;
   * идемпотентен, файл не трогает.
   */
  lock(): void;

  /**
   * TASK-093 §7: режим vault-а — источник состояния locked для контейнера/экрана
   * блокировки (§12). Читает заголовок файла (синхронно, однократно на вызов;
   * маленький JSON в userData): файла нет / v2 mode='safeStorage' / файл повреждён
   * → 'none' (повреждение вскроется при первом обращении к ключу — KEY_CORRUPT,
   * §13); v2 mode='passphrase' → 'passphrase'.
   */
  getMode(): VaultMode;
}
