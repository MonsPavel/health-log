/**
 * TASK-070 §5/§6/§7: контракт Data Care — канал `backup/create` и zod-схема
 * `BackupManifest` (манифест копии — часть контракта: восстановление TASK-071
 * валидирует его при разборе контейнера, §7).
 *
 * Контейнер копии (§4): `[magic 'HLBK1'][len(manifest-json)][manifest-json]
 * [iv 12б][ciphertext(снапшот БД)][auth-tag 16б]` — IV хранится рядом с
 * шифртекстом (не секрет; формат §4 структурно не меняет), auth-tag GCM
 * закрывает шифртекст, а манифест привязан к шифрованию как AAD (§14:
 * подмена метаданных детектируется той же проверкой целостности).
 *
 * Ключ содержимого (§8 — РЕШЕНИЕ): не ключ БД из KeyVault, а производный от
 * ПАРОЛЯ КОПИИ — KDF Argon2id, соль и параметры в манифесте (машинонезависимо:
 * копия восстанавливается на любом ПК). Исключение — `kdf: {id: 'db-key'}`:
 * АВТО-копия hook'а миграций создаётся без диалога (§5/§9 — спросить пароль
 * не у кого) и шифруется ключом БД напрямую; такая копия машиносвязна (для
 * отката миграции на той же машине), восстановление различает вид по полю
 * `kdf.id` (точка ветвления TASK-071/101).
 *
 * Пароль копии НЕ совпадает с паролем приложения (TASK-093) — независимые
 * секреты (§14); политика ≥8 символов — предупреждение UI (073), main не
 * блокирует (§13): схемой ограничены длина и непустота.
 *
 * message проверок — ключи i18n-каталога, не тексты (конвенция схем измерений).
 */
import { z } from 'zod';

/**
 * Запись KDF в манифесте (§8: «KDF Argon2id, соль в манифесте»; §14: параметры —
 * в файле, не в коде — эволюционируют, база TASK-093):
 *  - `argon2id` — пользовательская копия: ключ = Argon2id(пароль, salt, params);
 *  - `db-key` — авто-копия без диалога (hook миграций, §5/§9): ключ = ключ БД
 *    (32 байта hex из KeyVault той машины).
 */
export const BACKUP_KDF_ARGON2ID_SCHEMA = z
  .object({
    id: z.literal('argon2id'),
    /** Соль KDF (16 байт), base64. */
    saltB64: z.string().min(1),
    /** timeCost Argon2id (число итераций). */
    iterations: z.number().int().min(1).max(64),
    /** memoryCost Argon2id, КиБ (максимум манифеста — разумный потолок формы). */
    memoryKib: z.number().int().min(8).max(1_048_576),
    /** parallelism Argon2id (потоки). */
    parallelism: z.number().int().min(1).max(16),
  })
  .strict();

export const BACKUP_KDF_DB_KEY_SCHEMA = z.object({ id: z.literal('db-key') }).strict();

export const BACKUP_KDF_SCHEMA = z.discriminatedUnion('id', [
  BACKUP_KDF_DB_KEY_SCHEMA,
  BACKUP_KDF_ARGON2ID_SCHEMA,
]);

/** Манифест копии (§2/§7): все поля целиком читаются восстановлением (071). */
export const BACKUP_MANIFEST_SCHEMA = z
  .object({
    /** Версия формата контейнера (magic HLBK1 = 1, §4). */
    formatVersion: z.literal(1),
    /** schema_version БД на момент снапшота (из meta; свежая БД без meta — 0). */
    schemaVersion: z.number().int().min(0),
    /** Версия приложения, создавшего копию (титул «Health Log v{appVersion}»). */
    appVersion: z.string().min(1).max(32),
    /** Момент создания, мс эпохи Unix (UTC). */
    createdAtUtc: z.number().int().min(0),
    /** Счётчики снапшота (§5: measurements по COUNT; таблицы ещё нет — 0). */
    counts: z.object({ measurements: z.number().int().min(0) }).strict(),
    /** SHA-256 (hex, 64 символа) файла снапшота — сверяется при восстановлении (§14/071). */
    dbSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Запись KDF (§8 — см. шапку файла). */
    kdf: BACKUP_KDF_SCHEMA,
  })
  .strict();

export type BackupKdf = z.output<typeof BACKUP_KDF_SCHEMA>;
export type BackupManifest = z.output<typeof BACKUP_MANIFEST_SCHEMA>;

/**
 * Фазы прогресса создания копии (§5: snapshot/encrypt/write — coarse).
 * Доставка в рендерер — событие/канал 073; тип общий с этого момента.
 */
export type BackupPhase = 'snapshot' | 'encrypt' | 'write';

/**
 * Запрос создания копии (§6: `{mode: 'ask'|'auto'}`):
 *  - `ask` — пользовательская копия: пароль обязателен (§8; диалог ввода — 073),
 *    путь выбирает FileSaver-диалог main (§5);
 *  - `auto` — автоматическая копия без диалога (hook миграций, §5/§9): пароля нет
 *    (ключ БД), путь — `userData/backups`; `targetName` — имя файла (hook передаёт
 *    `pre-migration-vN.hlbackup`, §7); без него — метка времени.
 */
export const BACKUP_CREATE_REQUEST_SCHEMA = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('ask'),
      /** Пароль копии (§8). ≥8 символов — предупреждение UI 073, не блокировка (§13). */
      passphrase: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      mode: z.literal('auto'),
      /** Имя файла в каталоге копий; безопасный набор символов (IPC-гигиена, §14). */
      targetName: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.hlbackup$/)
        .optional(),
    })
    .strict(),
]);

/**
 * Ответ создания копии (§18): только basename файла — полный путь userData
 * содержит имя Windows-пользователя и наружу (renderer) не уходит (§14).
 */
export const BACKUP_CREATE_RESPONSE_SCHEMA = z
  .object({
    /** Имя файла копии (basename). */
    file: z.string().min(1).max(256),
    /** Размер контейнера, байт (лог/показ, §15). */
    sizeBytes: z.number().int().min(1),
    /** Манифест копии (факт создания: createdAtUtc, counts, …). */
    manifest: BACKUP_MANIFEST_SCHEMA,
  })
  .strict();

export type BackupCreateRequest = z.output<typeof BACKUP_CREATE_REQUEST_SCHEMA>;
export type BackupCreateResponse = z.output<typeof BACKUP_CREATE_RESPONSE_SCHEMA>;
