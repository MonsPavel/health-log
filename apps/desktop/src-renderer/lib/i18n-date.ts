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

/** Опции форматирования: локаль (по умолчанию ru-RU — каталог §17) и пресет. */
export interface FormatDateTimeOptions {
  readonly locale?: string;
  readonly preset: DateTimePreset;
}

const MS_PER_MINUTE = 60_000;

/** Локаль по умолчанию: каталог ru — источник истины (§17), en — пост-MVP. */
const DEFAULT_LOCALE = 'ru-RU';

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

/** Настенное время Instant в локализованном формате (§7). */
export function formatDateTime(instant: InstantLike, options: FormatDateTimeOptions): string {
  const { locale = DEFAULT_LOCALE, preset } = options;
  const wallMs = instant.utcMs + instant.tzOffsetMin * MS_PER_MINUTE;
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    ...PRESET_OPTIONS[preset],
  });
  return formatter.format(wallMs);
}
