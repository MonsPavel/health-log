/**
 * TASK-006 §5: реестр кодов ошибок. Начальный состав — три кода из §5; расширяется
 * последующими задачами: код добавляется в массив, строковый union выводится из него
 * автоматически (единственный источник истины). Формат кода: ДОМЕН/ПОДКОД.
 */
export const ERROR_CODES = [
  'APP/INTERNAL',
  'APP/NOT_IMPLEMENTED',
  'VALIDATION/FAILED',
  // TASK-016 §5: домен Measurement — VO давления/пульса (диапазоны; sys ≤ dia).
  'MEASUREMENT/INVALID_RANGE',
  'MEASUREMENT/SYS_LE_DIA',
  // TASK-017 §5: домен Measurement — агрегат BpMeasurement (время не в будущем;
  // заметка длиннее 500 символов).
  'MEASUREMENT/FUTURE_TIME',
  'MEASUREMENT/NOTE_TOO_LONG',
  // TASK-021 §5/§7: порт репозитория измерений — update/delete несуществующего id
  // (ошибка значением Result, не throw).
  'MEASUREMENT/NOT_FOUND',
  // TASK-022 §7/§13: SQLCipher-стек, открытие БД — неверный ключ (маппинг
  // SQLITE_NOTADB), файл занят другим процессом (SQLITE_BUSY/LOCKED; защита —
  // single-instance TASK-012), повреждение (PRAGMA quick_check при старте;
  // полный сценарий восстановления — TASK-100/101).
  'STORAGE/BAD_KEY',
  'STORAGE/LOCKED',
  'STORAGE/CORRUPT',
  // TASK-023 §5/§13: хранилище ключа БД (KeyVault на safeStorage): файла ключа нет при
  // существующей БД — потеря данных, восстановление из копии (TASK-101); файл есть, но
  // safeStorage не может расшифровать (сменился Windows-пользователь/машина) или файл
  // повреждён; шифрование ОС-хранилища недоступно (Linux без keyring — явная ошибка).
  'VAULT/KEY_MISSING',
  'VAULT/KEY_CORRUPT',
  'VAULT/UNAVAILABLE',
  // TASK-024 §5/§20: migration runner — сбой миграции (rollback, схема осталась на
  // предыдущей версии; params {version}); БД записана более новой версией приложения
  // (schema_version > известного) — явная ошибка «обновите приложение» (EC-25).
  'STORAGE/MIGRATION_FAILED',
  'STORAGE/DB_NEWER_THAN_APP',
  // TASK-026 §5/§9: SQLite-адаптер репозитория измерений — нарушение ограничений БД
  // (SQLITE_CONSTRAINT_*: UNIQUE/NOT NULL/FK/CHECK) и прочие ошибки выполнения SQL
  // (наружу только код, детали в cause — §14).
  'STORAGE/CONSTRAINT',
  'STORAGE/FAILED',
] as const;

/** Машинный код ошибки приложения (§7). */
export type ErrorCode = (typeof ERROR_CODES)[number];
