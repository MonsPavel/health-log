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
] as const;

/** Машинный код ошибки приложения (§7). */
export type ErrorCode = (typeof ERROR_CODES)[number];
