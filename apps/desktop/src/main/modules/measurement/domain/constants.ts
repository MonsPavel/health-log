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

/**
 * TASK-018 §4/§5: окно истории TypoHeuristic в днях. Отбор записей окна делает use
 * case (TASK-029, §7/§8: Instant-сравнение относительно moment кандидата) — сама
 * эвристика про время не знает. Правка числа = ревизия SRS, не поиск литералов.
 */
export const TYPO_WINDOW_DAYS = 14;

/**
 * TASK-018 §4/§13: порог «вероятной опечатки» в мм рт. ст. — отклонение значения
 * кандидата от медианы истории СТРОГО больше порога (ровно 40 — сигнала нет, §13).
 */
export const TYPO_THRESHOLD_MMHG = 40;

/**
 * TASK-019 §4/§5: окно «вероятного дубля» в миллисекундах — 2 минуты (SRS 07 EC-04:
 * двойное сохранение — Enter дважды). Правило: те же sys/dia в пределах окна от
 * существующей записи; граница ВКЛЮЧИТЕЛЬНО — ровно 120 000 мс → дубль, 120 001 —
 * нет (§13). Отбор «последних ~10 записей» делает use case (TASK-029, §7) — детектор
 * pure и про историю времени не знает. Правка числа = ревизия SRS, не поиск литералов.
 */
export const DUPLICATE_WINDOW_MS = 120_000;

/**
 * TASK-020 §4/§5: пороги критических значений (SRS FR-7.4, справочные материалы):
 * гипертонический криз — sys ≥ CRITICAL_HIGH_SYS (180) или dia ≥ CRITICAL_HIGH_DIA
 * (120) → 'high'; гипотензия — sys ≤ CRITICAL_LOW_SYS (90) или dia ≤
 * CRITICAL_LOW_DIA (60) → 'low'; иначе флага нет. Границы включительно (§13).
 * Правка числа = ревизия SRS, не поиск литералов. Потребители — use case add
 * (TASK-029, criticalValue в DTO TASK-028), панель срочной помощи (TASK-041),
 * пометки статистики (TASK-052), поведение ИИ (TASK-086 — импорт домена).
 */
export const CRITICAL_HIGH_SYS = 180;
export const CRITICAL_HIGH_DIA = 120;
export const CRITICAL_LOW_SYS = 90;
export const CRITICAL_LOW_DIA = 60;
