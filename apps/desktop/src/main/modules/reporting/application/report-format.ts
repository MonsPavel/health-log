/**
 * TASK-067 §13/§19: чистые форматтеры отчёта — application-слой reporting
 * (матрица арх. 03 §4: адаптер шаблона импортирует СВОЁ application; арх. 02 §5:
 * правила отображения — не в шаблоне; §7: никакой бизнес-логики в шаблоне).
 *
 * НАСТЕННОЕ ВРЕМЯ (§13, EC-06): дата/время точки — по ЕЁ собственному offset
 * (utcMs + tzOffsetMin), отформатированные Intl ru в UTC — машинная таймзона
 * на результат не влияет (детерминизм NFR-10: одинаковый вход → одинаковый PDF).
 *
 * ЧИСЛА (§13): средние отображаются целыми (округление к ближайшему); отсутствующее
 * значение (не измерен пульс, нет части суток) — прочерк «—».
 *
 * ТАБЛИЦА (§9/§19): лимит 2000 последних строк (защита от 100-страничных PDF —
 * решение зафиксировано) и разбивка на страницы по 30 строк (читаемость ≥9pt,
 * §16) — чистые функции, юнит-тесты §19.
 *
 * Файл в цепочке воркера (report-document.ts ← pdf-task.ts): внутри цепочки
 * импорты с '.ts'-спесификаторами (нативный Node type-stripping в тестах; tsc
 * переписывает в '.js' на emit — rewriteRelativeImportExtensions, TASK-067).
 * Сам файл без импортов — Intl и Date глобальны.
 */

/** Лимит строк таблицы отчёта (§9): последние 2000, приписка «показаны последние 2000 из N». */
export const TABLE_ROW_LIMIT = 2000;

/** Строк таблицы на страницу (§16: читаемость ≥9pt; заголовок повторяет `fixed`). */
export const TABLE_ROWS_PER_PAGE = 30;

const MS_PER_MINUTE = 60_000;

/**
 * Форматтеры Intl создаются ОДИН раз (лениво): 5k строк × 2 ячейки — тысячи
 * вызовов format(); пересоздание DateTimeFormat на вызов доминировало бы рендер
 * (§15). timeZone 'UTC' обязателен: момент уже сдвинут на offset точки.
 */
let dateShortFormatter: Intl.DateTimeFormat | undefined;
let timeFormatter: Intl.DateTimeFormat | undefined;
let dateLongFormatter: Intl.DateTimeFormat | undefined;

function wallDate(utcMs: number, tzOffsetMin: number): Date {
  return new Date(utcMs + tzOffsetMin * MS_PER_MINUTE);
}

function getDateShortFormatter(): Intl.DateTimeFormat {
  dateShortFormatter ??= new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return dateShortFormatter;
}

function getTimeFormatter(): Intl.DateTimeFormat {
  timeFormatter ??= new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return timeFormatter;
}

function getDateLongFormatter(): Intl.DateTimeFormat {
  dateLongFormatter ??= new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return dateLongFormatter;
}

/** Настенная дата точки «ДД.ММ.ГГГГ» (§13: Intl ru по offset точки). */
export function formatWallDate(utcMs: number, tzOffsetMin: number): string {
  return getDateShortFormatter().format(wallDate(utcMs, tzOffsetMin));
}

/** Настенное время точки «ЧЧ:ММ» (§13). */
export function formatWallTime(utcMs: number, tzOffsetMin: number): string {
  return getTimeFormatter().format(wallDate(utcMs, tzOffsetMin));
}

/** Длинная дата «1 сентября 2026 г.» — подзаголовок периода титула (§5). */
export function formatLongDate(utcMs: number, tzOffsetMin: number): string {
  return getDateLongFormatter().format(wallDate(utcMs, tzOffsetMin));
}

/** Дата-время одной строкой «01.09.2026, 21:07» — «Сформировано: …» (§5). */
export function formatDateTime(utcMs: number, tzOffsetMin: number): string {
  return `${formatWallDate(utcMs, tzOffsetMin)}, ${formatWallTime(utcMs, tzOffsetMin)}`;
}

/** Число целым (§13: средние — целые; округление к ближайшему). */
export function formatInt(value: number): string {
  return String(Math.round(value));
}

/** Значение с прочерком: undefined → «—» (§13: не измерен пульс / нет части суток). */
export function formatBp(value: number | undefined): string {
  return value === undefined ? '—' : formatInt(value);
}

/** Результат лимита таблицы (§9): оставшиеся строки + числа для приписки. */
export interface LimitedRows<T> {
  /** Последние `limit` строк в исходном (asc) порядке; ≤ лимита — копия входа. */
  readonly rows: T[];
  /** Всего строк в периоде (до лимита) — N для приписки. */
  readonly total: number;
  /** Сколько строк не попало в таблицу (0 — приписка не нужна). */
  readonly omitted: number;
}

/**
 * Ограничение таблицы последними `limit` записями (§9, решение зафиксировано):
 * отчёт печатает ХВОСТ периода (свежие записи важнее), порядок asc сохраняется.
 * Вход ожидается отсортированным asc (pdf-task сортирует до вызова, §5).
 */
export function limitLastRows<T>(
  rows: readonly T[],
  limit: number = TABLE_ROW_LIMIT,
): LimitedRows<T> {
  if (rows.length <= limit) {
    return { rows: [...rows], total: rows.length, omitted: 0 };
  }
  return {
    rows: [...rows.slice(rows.length - limit)],
    total: rows.length,
    omitted: rows.length - limit,
  };
}

/**
 * Разбивка строк таблицы на страницы (§19 «логика строк на страницу»): страницы
 * по `perPage` строк, последняя — остаток; пустой вход → ни одной страницы.
 * `perPage < 1` — TypeError (fail-fast §13: деление на нулевые страницы —
 * ошибка вызывающего кода, а не пустой отчёт).
 */
export function paginateRows<T>(rows: readonly T[], perPage: number): T[][] {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new TypeError(`paginateRows: perPage должен быть целым ≥ 1, получено ${perPage}`);
  }
  const pages: T[][] = [];
  for (let start = 0; start < rows.length; start += perPage) {
    pages.push(rows.slice(start, start + perPage));
  }
  return pages;
}
