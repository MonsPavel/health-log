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
] as const;

/** Машинный код ошибки приложения (§7). */
export type ErrorCode = (typeof ERROR_CODES)[number];
