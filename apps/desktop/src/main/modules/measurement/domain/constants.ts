/**
 * TASK-016 §3/§5: единственный источник границ измерений и ключей ошибок домена
 * Measurement. Источник чисел — SRS табл. 4.1 (docs/04-functional-requirements.md,
 * FR-1.2: СДА 50–300, ДДА 20–200, ЧСС 20–300): правка значения здесь = пересмотр SRS,
 * а не поиск литералов по коду. Потребители дублируют числа с комментарием-ссылкой
 * сюда: DDL CHECK — TASK-025, zod-схема формы — TASK-028 (§8, §10).
 */
export const BP_LIMITS = {
  SYS_MIN: 50,
  SYS_MAX: 300,
  DIA_MIN: 20,
  DIA_MAX: 200,
  PULSE_MIN: 20,
  PULSE_MAX: 300,
} as const;

/**
 * TASK-017 §5/§13: максимум заметки измерения в символах (SRS FR-1.1) — 500 ок,
 * 501 → NOTE_TOO_LONG. Дублируется в zod-схеме контракта (TASK-028) с
 * комментарием-ссылкой сюда (§22 TASK-017).
 */
export const NOTE_MAX_LENGTH = 500;

/**
 * Ключи i18n-каталога для кодов MEASUREMENT/* по конвенции арх. 05 §29
 * (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); сами тексты появляются в каталоге в TASK-031/032.
 */
export const INVALID_RANGE_MESSAGE_KEY = 'errors.MEASUREMENT_INVALID_RANGE';
export const SYS_LE_DIA_MESSAGE_KEY = 'errors.MEASUREMENT_SYS_LE_DIA';
/** TASK-017 §5/§16–17: ключ для MEASUREMENT/FUTURE_TIME. */
export const FUTURE_TIME_MESSAGE_KEY = 'errors.MEASUREMENT_FUTURE_TIME';
/** TASK-017 §5/§16–17: ключ для MEASUREMENT/NOTE_TOO_LONG (params {max}). */
export const NOTE_TOO_LONG_MESSAGE_KEY = 'errors.MEASUREMENT_NOTE_TOO_LONG';
