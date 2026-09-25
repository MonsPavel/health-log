/**
 * TASK-006 §7: Instant — момент времени как пара (utcMs, tzOffsetMin).
 *
 * Правила времени (арх. 04 §2, EC-06/07): сортировки и периоды — только по UTC
 * (Instant.compare); настенное время (UTC + offset) — только для утро/вечер и
 * группировки дней. Запись хранит СВОЙ offset, поэтому перелёты и переводы часов
 * не «перемещают» исторические измерения (§13).
 *
 * Все операции — целочисленная арифметика без создания Date-объектов (§15);
 * календарная математика — алгоритмы Хиннанта civil_from_days/days_from_civil.
 */

/** Настенное время момента: локальные компоненты в момент измерения (§7). */
export interface WallTime {
  /** Год, например 2026. */
  y: number;
  /** Месяц 1–12. */
  m: number;
  /** День 1–31. */
  d: number;
  /** Час 0–23. */
  h: number;
  /** Минута 0–59. */
  min: number;
}

/** Момент времени: плоский структурный тип (IPC/БД — §8/§11). */
export interface Instant {
  /** Миллисекунды с эпохи Unix (UTC). */
  readonly utcMs: number;
  /** Смещение пояса момента измерения в минутах: UTC+3 → 180, UTC-5 → -300. */
  readonly tzOffsetMin: number;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;
const MS_PER_DAY = 86_400_000;
const DAYS_BEFORE_ERA = 719_468; // от 0000-03-01 (начала календаря Хиннанта) до эпохи
const DAYS_PER_ERA = 146_097; // длина 400-летнего цикла григорианского календаря

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Гражданская дата из числа дней с эпохи 1970-01-01 (civil_from_days Хиннанта). */
function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + DAYS_BEFORE_ERA;
  const era = floorDiv(z, DAYS_PER_ERA);
  const doe = z - era * DAYS_PER_ERA; // [0, 146096]
  const yoe = floorDiv(
    doe - floorDiv(doe, 1_460) + floorDiv(doe, 36_524) - floorDiv(doe, 146_096),
    365,
  ); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100)); // [0, 365]
  const mp = floorDiv(5 * doy + 2, 153); // [0, 11]
  const d = doy - floorDiv(153 * mp + 2, 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** Число дней с эпохи 1970-01-01 из гражданской даты (days_from_civil Хиннанта). */
function daysFromCivil(year: number, m: number, d: number): number {
  const y = year - (m <= 2 ? 1 : 0);
  const era = floorDiv(y, 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = floorDiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy; // [0, 146096]
  return era * DAYS_PER_ERA + doe - DAYS_BEFORE_ERA;
}

/** Настенное время: UTC + offset; отрицательные offset и переход через полночь (§13). */
function wallTime(instant: Instant): WallTime {
  const wallMinutes = floorDiv(instant.utcMs, MS_PER_MINUTE) + instant.tzOffsetMin;
  const dayIndex = floorDiv(wallMinutes, MINUTES_PER_DAY);
  const minuteOfDay = wallMinutes - dayIndex * MINUTES_PER_DAY; // [0, 1439]
  const civil = civilFromDays(dayIndex);

  return {
    y: civil.y,
    m: civil.m,
    d: civil.d,
    h: floorDiv(minuteOfDay, 60),
    min: minuteOfDay % 60,
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatOffset(tzOffsetMin: number): string {
  const sign = tzOffsetMin < 0 ? '-' : '+';
  const abs = Math.abs(tzOffsetMin);

  return `${sign}${pad(floorDiv(abs, 60), 2)}:${pad(abs % 60, 2)}`;
}

/** ISO 8601 с настенным временем и offset: `2026-09-25T14:30:05.123+03:00`. */
function toIso(instant: Instant): string {
  const wall = wallTime(instant);
  const msOfMinute = instant.utcMs - floorDiv(instant.utcMs, MS_PER_MINUTE) * MS_PER_MINUTE; // [0, 59999]
  const sec = floorDiv(msOfMinute, 1_000);
  const ms = msOfMinute % 1_000;

  return (
    `${pad(wall.y, 4)}-${pad(wall.m, 2)}-${pad(wall.d, 2)}` +
    `T${pad(wall.h, 2)}:${pad(wall.min, 2)}:${pad(sec, 2)}.${pad(ms, 3)}` +
    formatOffset(instant.tzOffsetMin)
  );
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})([+-])(\d{2}):(\d{2})$/;

/** Разбор строки toIso; обратим к toIso: fromIso(toIso(x)) ≡ x (§13, инвариант 1). */
function fromIso(iso: string): Instant {
  const match = ISO_PATTERN.exec(iso);
  if (match === null) {
    throw new Error(`Instant.fromIso: строка не в формате toIso (ISO 8601 с offset): ${iso}`);
  }
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  const sec = Number(match[6]);
  const ms = Number(match[7]);
  const offsetSign = match[8] === '-' ? -1 : 1;
  const offH = Number(match[9]);
  const offM = Number(match[10]);

  const inRange =
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= 31 &&
    h <= 23 &&
    mi <= 59 &&
    sec <= 59 &&
    offH <= 23 &&
    offM <= 59;
  if (!inRange) {
    throw new Error(`Instant.fromIso: компоненты даты/времени вне диапазона: ${iso}`);
  }

  const tzOffsetMin = offsetSign * (offH * 60 + offM);
  const utcMs =
    daysFromCivil(y, mo, d) * MS_PER_DAY +
    h * 3_600_000 +
    mi * MS_PER_MINUTE +
    sec * 1_000 +
    ms -
    tzOffsetMin * MS_PER_MINUTE;

  return { utcMs, tzOffsetMin };
}

/** Сравнение строго по utcMs; offset не участвует (сортировки — только UTC, §13). */
function compare(a: Instant, b: Instant): -1 | 0 | 1 {
  if (a.utcMs < b.utcMs) {
    return -1;
  }
  return a.utcMs > b.utcMs ? 1 : 0;
}

/**
 * Операции над Instant; вызов `Instant.fromIso(...)` — нотация контракта §7.
 * Сам Instant — структурный тип (плоский объект), т.е. `const x: Instant = { utcMs, tzOffsetMin }`.
 */
export const Instant = { wallTime, toIso, fromIso, compare };
