/**
 * TASK-013 §7: formatDateTime — настенное время Instant через Intl.DateTimeFormat
 * (арх. 06 §6: формат дат/чисел — Intl API по выбранной локали, FR-8.4).
 *
 * Серверные дата/время приходят как Instant из kernel (TASK-006) — пара
 * {utcMs, tzOffsetMin}. Тип InstantLike структурно совпадает с kernel-Instant:
 * рендерер не импортирует @hl/kernel (арх. 03 §4 — только @hl/contracts), а
 * структурная типизация делает присваивание без импорта.
 *
 * Настенное время = utcMs + tzOffsetMin; сдвинутый момент форматируется в
 * timeZone 'UTC' — Intl показывает именно настенные компоненты записи (запись
 * хранит СВОЙ offset: перелёты не «перемещают» историю, арх. 04 §2).
 * Пресеты — до минут: настенное время kernel до минут (утро/вечер, §7).
 */

/** Структурный аналог kernel-Instant (IPC/БД — плоский объект, §8/§11). */
export interface InstantLike {
  /** Миллисекунды с эпохи Unix (UTC). */
  readonly utcMs: number;
  /** Смещение пояса момента в минутах: UTC+3 → 180, UTC-5 → -300. */
  readonly tzOffsetMin: number;
}

/** Пресеты отображения (§7): дата+время / только дата / только время. */
export type DateTimePreset = 'datetime' | 'date' | 'time';

/**
 * Пресет порядка даты из prefs (TASK-047 §13): auto — Intl по локали; dmy/mdy —
 * явный выбор пользователя. Тип — структурный аналог Prefs['dateFormat'] (contracts):
 * рендерер импортирует @hl/contracts, дублирование типа здесь осознанно не делается —
 * утилита принимает строковое подмножество.
 */
export type DateFormatPreset = 'auto' | 'dmy' | 'mdy';

/** Опции форматирования: локаль (по умолчанию ru-RU — каталог §17), пресет и prefs-порядок даты. */
export interface FormatDateTimeOptions {
  readonly locale?: string;
  readonly preset: DateTimePreset;
  /** Порядок даты из prefs (§13); по умолчанию 'auto'. */
  readonly dateFormat?: DateFormatPreset;
}

const MS_PER_MINUTE = 60_000;

/** Локаль по умолчанию: каталог ru — источник истины (§17), en — пост-MVP. */
const DEFAULT_LOCALE = 'ru-RU';

/**
 * Явный порядок даты (§13): dmy — ru-пресет Intl, mdy — en-пресет; переопределяет
 * locale-параметр для компонент даты (время остаётся локальным).
 */
const DATE_FORMAT_LOCALES: Readonly<Record<Exclude<DateFormatPreset, 'auto'>, string>> = {
  dmy: 'ru-RU',
  mdy: 'en-US',
};

/** Опции пресетов: минуты всегда с ведущим нулём, стиль даты — числовой. */
const PRESET_OPTIONS: Readonly<Record<DateTimePreset, Intl.DateTimeFormatOptions>> = {
  datetime: {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
  date: { day: '2-digit', month: '2-digit', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
};

/** Настенное время Instant в локализованном формате (§7); порядок даты — prefs-пресет (TASK-047 §13). */
export function formatDateTime(instant: InstantLike, options: FormatDateTimeOptions): string {
  const { locale = DEFAULT_LOCALE, preset, dateFormat = 'auto' } = options;
  const wallMs = instant.utcMs + instant.tzOffsetMin * MS_PER_MINUTE;
  // auto → Intl по locale-параметру (естественный формат локали, TASK-013 FR-8.4);
  // dmy/mdy → фиксированная локаль пресета: prefs выбирает ПОРЯДОК даты, а не формат
  // времени — часовой цикл фиксируется 24-часовым (иначе en-US давал бы «02:30 PM»).
  const formatterOptions: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC',
    ...PRESET_OPTIONS[preset],
  };
  if (dateFormat !== 'auto') {
    formatterOptions.hourCycle = 'h23';
  }
  const effectiveLocale = dateFormat === 'auto' ? locale : DATE_FORMAT_LOCALES[dateFormat];
  const formatter = new Intl.DateTimeFormat(effectiveLocale, formatterOptions);
  return formatter.format(wallMs);
}
