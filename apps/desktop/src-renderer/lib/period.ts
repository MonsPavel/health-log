/**
 * TASK-057 §4/§5/§6: общие период-утилиты продукта — ПЕРЕНОС из
 * features/measurement/model (период-часть filters.ts TASK-044/046 + range.ts +
 * tzOffsetMinOf taken-at) в lib. Один паттерн period по продукту: URL-семантики
 * фильтров журнала и экрана «Динамика» — одни и те же (§4 057: «переиспользование
 * TASK-044/046»), копии утилит не создаются. Старые точки импорта
 * (model/range.ts, model/filters.ts, model/taken-at.ts) — реэкспорты (§6:
 * «реэкспорт утилит фильтров»), публичное API журнала не меняется.
 *
 * Слои: lib не импортирует features — зависимости только @hl/contracts
 * (тип StatsPeriodParam каналов stats/period и trend/series).
 *
 * СЕМАНТИКА (перенесена как есть, §13/§14 044/046):
 *  - пресеты: from = now − N*86400000 ВКЛИЧИТЕЛЬНО (граница — точка включения
 *    записи портом TASK-021); «всё» → границ нет; «сейчас» фиксирует вызывающий;
 *  - custom: настенные даты устройства (range.parseRange) — from = полночь
 *    настенного дня, to = 23:59:59.999 дня включительно (записи включаются по
 *    настенному дню измерения, EC-06); неполный диапазон — открытая сторона;
 *    пустые оба и невалидные даты → границы дефолтного 30d (режим custom в URL
 *    сохраняется — поля остаются видимы); to в будущем отсекается (EC-20);
 *  - URL: период пишется всегда (дефолт виден в адресе), from/to — только при
 *    custom; парсер строгий: мусор → дефолт, ошибок не выдаёт.
 *
 * periodToStatsParam (новое, §11 057): конвертация состояния в период каналов
 * stats/period и trend/series (схема STATS_PERIOD_PARAM — ТА ЖЕ, §23 054/056).
 * Пресеты уходят строкой — границы считает main от Clock (§9 054). Custom
 * передаёт готовые utcMs-границы (обе включительно, канал требует ОБЕ):
 * открытая сторона закрывается — «нет to» → now (будущих записей нет — EC-20
 * отсекает futureTo на вводе), «нет from» → 0 (начало времён).
 */
import type { StatsPeriodParam } from '@hl/contracts';

/** Миллисекунд в минуте (целочисленная арифметика настенных компонентов). */
export const MS_PER_MINUTE = 60_000;

/** Миллисекунд в сутках — единица пресетов (§22 044: 7×24ч, не календарная неделя). */
export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Календарная математика произвольного периода (перенос model/range.ts, TASK-046)
// ---------------------------------------------------------------------------

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
 * календарного дня (2026-02-30 и 02-29 невисокосного — мусор). Пустая/absent
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

/** Виды ошибок валидации диапазона (§5/§17 046: invalidOrder/futureTo — ключи UI). */
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
 * parseRange (§7 046): настенные даты устройства → границы utcMs через переданную
 * зону. Пустые строки = параметр не задан (обе пустые → ok без границ; дефолт
 * 30d в этом случае применяет periodToBounds). Порядок проверок: формат →
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

/**
 * Смещение зоны устройства в момент nowMs, минут (перенос model/taken-at.ts):
 * getTimezoneOffset() отдаёт минуты ДОБАВЛЯЕМЫЕ к локальному времени для получения
 * UTC (UTC+3 → -180) — Instant хранит обратный знак (§13).
 */
export function tzOffsetMinOf(nowMs: number): number {
  return -new Date(nowMs).getTimezoneOffset();
}

// ---------------------------------------------------------------------------
// Период как состояние URL (перенос период-части filters.ts, TASK-044/046)
// ---------------------------------------------------------------------------

/** Период фильтра (§7 044): пресеты и произвольный диапазон (TASK-046 §5). */
export type Period = '7d' | '30d' | '90d' | 'all' | 'custom';

/** Сутки пресета; отсутствующие периоды границ не дают. */
const PERIOD_DAYS: Readonly<Record<Exclude<Period, 'all' | 'custom'>, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Периоды, валидные в URL (§5: custom — с from/to, TASK-046). */
const URL_PERIODS = ['7d', '30d', '90d', 'all', 'custom'] as const;

/** Дефолтный период (§5 044: сброс → URL `?period=30d`). */
export const DEFAULT_PERIOD: Period = '30d';

/**
 * Период-состояние экрана (§12 057: URL `?period=` — истина) — период-часть
 * HistoryFilterState 044/046 БЕЗ arm/noted/q (те остаются фильтрами журнала).
 */
export interface PeriodState {
  readonly period: Period;
  /** Настенная дата «от» 'YYYY-MM-DD' — только режим custom (TASK-046 §5). */
  readonly from?: string;
  /** Настенная дата «до» 'YYYY-MM-DD' — только режим custom (TASK-046 §5). */
  readonly to?: string;
}

/** Минимальная поверхность чтения параметров (URLSearchParams и ReadonlyURLSearchParams роутера). */
export interface ParamsReader {
  get(name: string): string | null;
}

/**
 * Парсер URL → состояние периода (§14): мусор в любом поле → дефолт этого поля;
 * from/to читаются только при period=custom, строгий ISO-календарь (parseIsoDate),
 * from > to — весь custom мусорен → дефолт. Посторонние параметры (arm/noted/q
 * журнала) игнорируются — их читает parseHistoryFilters (model/filters).
 */
export function parsePeriodState(params: ParamsReader): PeriodState {
  const periodRaw = params.get('period');
  const period = URL_PERIODS.find((candidate) => candidate === periodRaw);
  const isCustom = period === 'custom';
  const fromRaw = isCustom ? params.get('from') : null;
  const toRaw = isCustom ? params.get('to') : null;
  const from = fromRaw === null ? null : parseIsoDate(fromRaw);
  const to = toRaw === null ? null : parseIsoDate(toRaw);
  // Порядок дат виден лексикографически (нормализованные ISO-строки) — как в 046.
  const rangeBroken =
    from !== null && to !== null && fromRaw !== null && toRaw !== null && fromRaw > toRaw;
  if (period === undefined || rangeBroken) {
    return { period: DEFAULT_PERIOD };
  }
  return {
    period,
    ...(from === null || fromRaw === null ? {} : { from: fromRaw }),
    ...(to === null || toRaw === null ? {} : { to: toRaw }),
  };
}

/**
 * Состояние → URLSearchParams (§12): период всегда (дефолт виден в адресе),
 * from/to — только при custom (§5 046: `period=custom&from=&to=`), как есть —
 * валидность гарантируют парсер и UI (CustomRangeFields блокирует невалидные).
 */
export function serializePeriodState(state: PeriodState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('period', state.period);
  if (state.period === 'custom') {
    if (state.from !== undefined) {
      params.set('from', state.from);
    }
    if (state.to !== undefined) {
      params.set('to', state.to);
    }
  }
  return params;
}

/**
 * Границы периода в utcMs (период-часть toQuery 044): пресеты — от переданного
 * nowUtcMs включительно, «всё» — без границ; custom — настенные дни через
 * parseRange в зоне устройства момента now; пустые оба и невалидные даты →
 * границы дефолтного 30d (§10/§14 046 — «всё» из мусора не строится никогда).
 */
export function periodToBounds(state: PeriodState, nowUtcMs: number): RangeBounds {
  if (state.period === 'custom') {
    const range = parseRange(state.from, state.to, nowUtcMs, tzOffsetMinOf(nowUtcMs));
    if (range.ok && (range.fromUtcMs !== undefined || range.toUtcMs !== undefined)) {
      return {
        ...(range.fromUtcMs === undefined ? {} : { fromUtcMs: range.fromUtcMs }),
        ...(range.toUtcMs === undefined ? {} : { toUtcMs: range.toUtcMs }),
      };
    }
    return { fromUtcMs: nowUtcMs - PERIOD_DAYS['30d'] * DAY_MS };
  }
  const days = state.period === 'all' ? undefined : PERIOD_DAYS[state.period];
  return days === undefined ? {} : { fromUtcMs: nowUtcMs - days * DAY_MS };
}

/**
 * Состояние → период каналов stats/period и trend/series (§11 057; схема — ТА ЖЕ
 * STATS_PERIOD_PARAM, §23 054/056): пресеты — строкой (границы считает main от
 * Clock, §9 054); custom — готовые utcMs-границы, обе включительно. Открытая
 * сторона custom закрывается: «нет to» → now (будущих записей нет — EC-20
 * отсекает futureTo на вводе), «нет from» → 0 (начало времён).
 */
export function periodToStatsParam(state: PeriodState, nowUtcMs: number): StatsPeriodParam {
  if (state.period !== 'custom') {
    return state.period;
  }
  const bounds = periodToBounds(state, nowUtcMs);
  return {
    fromUtcMs: bounds.fromUtcMs ?? 0,
    toUtcMs: bounds.toUtcMs ?? nowUtcMs,
  };
}
