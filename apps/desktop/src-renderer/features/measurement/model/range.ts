/**
 * TASK-046 §7/§13/§14: конвертер и валидатор произвольного периода — настенные
 * даты (устройство) → границы utcMs.
 *
 * Настенное правило (§7, согласовано с группировкой TASK-033/wall-date): записи
 * включаются по НАСТЕННОМУ дню измерения (Instant.wallTime — utcMs + СВОЙ
 * tzOffsetMin записи), поэтому границы считаются в настенной зоне устройства:
 * from = полночь настенного дня ВКЛЮЧИТЕЛЬНО, to = 23:59:59.999 настенного дня
 * ВКЛЮЧИТЕЛЬНО. Ночная запись 00:15 «вчерашнего» дня остаётся во «вчера», хотя
 * её UTC-день другой (тест range.test §13).
 *
 * Чистые функции (прецедент taken-at.ts): момент «сейчас» и смещение зоны
 * передаются параметром, скрытых Date.now()/getTimezoneOffset нет; целочисленная
 * арифметика без Date-объектов в границах (§15). Смещение зоны ФИКСИРОВАНО на
 * весь диапазон (offset устройства сейчас): настенные дни идут подряд по 24 ч —
 * DST-переход внутри диапазона не дублирует и не выпадает из дней (§13).
 *
 * Renderer не импортирует @hl/kernel (депкруз renderer-not-node, арх. 03 §4) —
 * календарная математика на Date.UTC (компоненты из строк уже валидированы).
 */

/** Миллисекунд в минуте (прецедент taken-at.MS_PER_MINUTE / kernel). */
export const MS_PER_MINUTE = 60_000;

/** Миллисекунд в сутках (единица настенных дней, прецедент filters.DAY_MS). */
export const DAY_MS = 86_400_000;

/** Календарная дата без времени (компоненты ISO-строки). */
export interface CalendarDate {
  /** Год, например 2026. */
  readonly y: number;
  /** Месяц 1–12. */
  readonly mo: number;
  /** День 1–31. */
  readonly d: number;
}

/** Строгий шаблон ISO-даты 'YYYY-MM-DD': ровно 4-2-2 цифры, ничего лишнего. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Разбор ISO-даты URL-параметра (§14): строгий формат + существование
 * календарного дня (2026-02-30 и 02-29 невисокосного — мусор). Пустая/ absent
 * строка — параметр не задан → null (это НЕ ошибка формата).
 */
export function parseIsoDate(value: string | null | undefined): CalendarDate | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  // Проверка существования дня: Date.UTC нормализует переполнения (02-30 → 03-02),
  // поэтому компоненты обязаны собраться обратно (високосность включительно).
  const utcMs = Date.UTC(y, mo - 1, d);
  const date = new Date(utcMs);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return { y, mo, d };
}

/** Виды ошибок валидации диапазона (§5/§17: invalidOrder/futureTo — ключи UI). */
export type RangeErrorKind = 'invalidFormat' | 'invalidOrder' | 'futureTo';

/** Границы диапазона в utcMs; отсутствующая сторона — «открытая» (§10 прогрессивно). */
export interface RangeBounds {
  /** Полночь настенного дня from, включительно (§13). */
  readonly fromUtcMs?: number;
  /** 23:59:59.999 настенного дня to, включительно (§13). */
  readonly toUtcMs?: number;
}

/** Результат parseRange: границы или ошибка валидации (дискриминатор ok — прецедент конвертов IPC). */
export type ParseRangeResult =
  ({ readonly ok: true } & RangeBounds) | { readonly ok: false; readonly error: RangeErrorKind };

/** Номер настенного дня (дней с эпохи) календарной даты — целочисленное сравнение дат. */
function dayNumberOf(y: number, mo: number, d: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);
}

/** Полночь настенного дня в зоне устройства → utcMs (§13: Date.UTC минус offset). */
function dayStartUtcMs(dayNumber: number, tzOffsetMin: number): number {
  return dayNumber * DAY_MS - tzOffsetMin * MS_PER_MINUTE;
}

/** 23:59:59.999 настенного дня в зоне устройства → utcMs (включительный конец, §13). */
function dayEndUtcMs(dayNumber: number, tzOffsetMin: number): number {
  return dayStartUtcMs(dayNumber, tzOffsetMin) + DAY_MS - 1;
}

/**
 * parseRange (§7): настенные даты устройства → границы utcMs через переданную
 * зону. Пустые строки = параметр не задан (обе пустые → ok без границ; дефолт
 * 30d в этом случае применяет toQuery, §10). Порядок проверок: формат →
 * from ≤ to → to не в будущем (настенное «сегодня» от nowUtcMs + offset).
 */
export function parseRange(
  fromStr: string | null | undefined,
  toStr: string | null | undefined,
  nowUtcMs: number,
  tzOffsetMin: number,
): ParseRangeResult {
  const from = parseIsoDate(fromStr);
  const to = parseIsoDate(toStr);
  const fromStrEmpty = fromStr === null || fromStr === undefined || fromStr === '';
  const toStrEmpty = toStr === null || toStr === undefined || toStr === '';
  // Мусор формата при непустой строке — invalidFormat (§14: валидатор → дефолт).
  if ((!fromStrEmpty && from === null) || (!toStrEmpty && to === null)) {
    return { ok: false, error: 'invalidFormat' };
  }
  if (from === null && to === null) {
    return { ok: true };
  }

  const fromDay = from === null ? undefined : dayNumberOf(from.y, from.mo, from.d);
  const toDay = to === null ? undefined : dayNumberOf(to.y, to.mo, to.d);
  if (fromDay !== undefined && toDay !== undefined && fromDay > toDay) {
    return { ok: false, error: 'invalidOrder' };
  }
  // Настенное «сегодня» устройства: номер дня момента now в зоне tzOffsetMin.
  const todayDay = Math.floor((nowUtcMs + tzOffsetMin * MS_PER_MINUTE) / DAY_MS);
  if (toDay !== undefined && toDay > todayDay) {
    return { ok: false, error: 'futureTo' };
  }

  return {
    ok: true,
    ...(fromDay === undefined ? {} : { fromUtcMs: dayStartUtcMs(fromDay, tzOffsetMin) }),
    ...(toDay === undefined ? {} : { toUtcMs: dayEndUtcMs(toDay, tzOffsetMin) }),
  };
}
