/**
 * TASK-044 §7/§13/§14: чистая модель фильтров истории — состояние ↔ URL ↔ query.
 *
 * Состояние (§7): HistoryFilterState {period, from?, to?, arm?, noted?, q?}.
 * TASK-046 custom: period='custom' — произвольный диапазон с настенными датами
 * from/to ('YYYY-MM-DD', ISO). Границы запроса (§13) считаются toQuery через
 * parseRange (model/range §7): from = полночь настенного дня, to =
 * 23:59:59.999 настенного дня включительно — записи включаются по настенному
 * дню измерения (согласовано с группировкой TASK-033). Неполный диапазон —
 * открытая сторона (§10 прогрессивно: только from → «от даты до ∞»); пустые
 * оба и невалидные даты → границы дефолтного 30d (§10/§14), режим custom в URL
 * при этом сохраняется — поля остаются видимы.
 *
 * Границы пресета (§13): fromUtcMs = nowUtcMs − N*86400000 ВКЛЮЧИТЕЛЬНО —
 * запись ровно на границе 7 дней попадает в выборку (включительные границы
 * порта — TASK-021); «всё» → from отсутствует. nowUtcMs передаётся параметром —
 * момент применения фиксирует вызывающий (хук useMeasurementFilters), не
 * каждый рендер.
 *
 * URL (§3/§12): источник истины фильтров — сериализуем и шаро-пригоден.
 * Сериализатор всегда пишет period (дефолт 30d виден в адресе — сброс даёт
 * `?period=30d`, §5); custom добавляет from/to (§5: `period=custom&from=&to=`),
 * arm/noted — только непустые (`noted=1`). Парсер строгий: неизвестные значения
 * → дефолт; from/to читаются только при period=custom, строгий ISO-календарь
 * (parseIsoDate), мусор отбрасывается, from > to — весь custom мусорен →
 * дефолт (мусор URL не выдаёт ошибок и не доходит до запроса list, §14);
 * посторонние параметры игнорирует. to-в-будущем парсер не видит (нужен now) —
 * отсекается toQuery (parseRange futureTo → дефолт 30d, EC-20).
 */
import type { MeasurementDto, MeasurementListRequest } from '@hl/contracts';

import { parseIsoDate, parseRange } from './range';
import { tzOffsetMinOf } from './taken-at';

/** Период фильтра (§7): пресеты и произвольный диапазон (TASK-046 §5). */
export type HistoryPeriod = '7d' | '30d' | '90d' | 'all' | 'custom';

/** Рука фильтра — те же значения, что ArmSchema контрактов (§4). */
export type HistoryArm = MeasurementListRequest['arm'];

/** Состояние панели фильтров (§7): URL-восстановимо, дефолт — 30d. TASK-045: + q. */
export interface HistoryFilterState {
  readonly period: HistoryPeriod;
  /** Настенная дата «от» 'YYYY-MM-DD' — только режим custom (TASK-046 §5). */
  readonly from?: string;
  /** Настенная дата «до» 'YYYY-MM-DD' — только режим custom (TASK-046 §5). */
  readonly to?: string;
  readonly arm?: HistoryArm;
  readonly noted?: boolean;
  /** Строка поиска по заметкам (§5: URL ?q=); пустой/пробельный ввод — параметра нет. */
  readonly q?: string;
}

/** Сутки в мс — единица пресетов (§22: принято 7×24ч, не календарная неделя). */
export const DAY_MS = 86_400_000;

/** Дефолтное состояние фильтров (§5: сброс → URL `?period=30d`). */
export const DEFAULT_FILTER_STATE: HistoryFilterState = { period: '30d' };

/** Сутки пресета; отсутствующие периоды границ не дают. */
const PERIOD_DAYS: Readonly<Record<Exclude<HistoryPeriod, 'all' | 'custom'>, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/**
 * Фрагмент MeasurementListRequest (§4: фильтры уже в контракте TASK-028) —
 * ровно то, что добавляется к запросу list и к ключу кэша (§12). Ключи с
 * undefined не создаются — объект sparse, чтобы ключ кэша был стабильным.
 */
export type MeasurementQueryFragment = Pick<
  MeasurementListRequest,
  'fromUtcMs' | 'toUtcMs' | 'arm' | 'hasNote'
>;

/**
 * Состояние → фрагмент запроса list (§7): чистая функция; границы пресета — от
 * переданного nowUtcMs (момент применения), hand/hasNote — как есть.
 * TASK-046 custom (§7/§10): границы настенных дней через parseRange в зоне
 * устройства момента now (tzOffsetMinOf); пустые оба и невалидные даты →
 * границы дефолтного 30d (§10/§14) — запрос без границ («всё») из custom не
 * строится никогда.
 */
export function toQuery(state: HistoryFilterState, nowUtcMs: number): MeasurementQueryFragment {
  const tail = {
    ...(state.arm === undefined ? {} : { arm: state.arm }),
    ...(state.noted === true ? { hasNote: true } : {}),
  };
  if (state.period === 'custom') {
    const range = parseRange(state.from, state.to, nowUtcMs, tzOffsetMinOf(nowUtcMs));
    if (range.ok && (range.fromUtcMs !== undefined || range.toUtcMs !== undefined)) {
      return {
        ...(range.fromUtcMs === undefined ? {} : { fromUtcMs: range.fromUtcMs }),
        ...(range.toUtcMs === undefined ? {} : { toUtcMs: range.toUtcMs }),
        ...tail,
      };
    }
    // §10 (пустые оба) / §14 (invalidFormat/invalidOrder/futureTo — рукописный
    // URL): дефолтные границы 30d, диапазон «всё» из мусора не получается.
    return { fromUtcMs: nowUtcMs - PERIOD_DAYS['30d'] * DAY_MS, ...tail };
  }
  const days = state.period === 'all' ? undefined : PERIOD_DAYS[state.period];
  return {
    ...(days === undefined ? {} : { fromUtcMs: nowUtcMs - days * DAY_MS }),
    ...tail,
  };
}

/** Минимальная поверхность чтения параметров (URLSearchParams и ReadonlyURLSearchParams роутера). */
interface ParamsReader {
  get(name: string): string | null;
}

/** Периоды, валидные в URL (§5: custom — с from/to, TASK-046). */
const URL_PERIODS = ['7d', '30d', '90d', 'all', 'custom'] as const;

/** Парсер URL → состояние (§7/§14): мусор в любом поле → дефолт этого поля. */
export function parseHistoryFilters(params: ParamsReader): HistoryFilterState {
  const period = params.get('period');
  const arm = params.get('arm');
  const noted = params.get('noted');
  // TASK-045 §10: q — поисковая строка; пустая/пробельная считается отсутствующей
  // (поиск не активен), непустая — хранится как есть (trim делает хук поиска).
  const q = params.get('q');
  const validQ = q !== null && q.trim() !== '' ? q : undefined;
  const validPeriod = URL_PERIODS.find((candidate) => candidate === period);
  const validArm: HistoryArm | undefined = arm === 'left' || arm === 'right' ? arm : undefined;
  // TASK-046 §5/§14: from/to — только в режиме custom, строгий ISO-календарь
  // (parseIsoDate); мусорная дата отбрасывается, from > to — весь custom мусорен
  // (период → дефолт; у нормализованных ISO-строк порядок виден лексикографически).
  // futureTo парсер не проверяет (нужен now) — отсекает toQuery (дефолт 30d, EC-20).
  const isCustom = validPeriod === 'custom';
  const fromRaw = isCustom ? params.get('from') : null;
  const toRaw = isCustom ? params.get('to') : null;
  const from = fromRaw === null ? null : parseIsoDate(fromRaw);
  const to = toRaw === null ? null : parseIsoDate(toRaw);
  const rangeBroken =
    from !== null && to !== null && fromRaw !== null && toRaw !== null && fromRaw > toRaw;
  return {
    period: rangeBroken ? DEFAULT_FILTER_STATE.period : (validPeriod ?? DEFAULT_FILTER_STATE.period),
    ...(from === null || fromRaw === null || rangeBroken ? {} : { from: fromRaw }),
    ...(to === null || toRaw === null || rangeBroken ? {} : { to: toRaw }),
    ...(validArm === undefined ? {} : { arm: validArm }),
    ...(noted === '1' ? { noted: true } : {}),
    ...(validQ === undefined ? {} : { q: validQ }),
  };
}

/**
 * Состояние → URLSearchParams (§12): period всегда (дефолт виден в адресе),
 * from/to — при custom (§5: `period=custom&from=&to=`), arm/noted — только
 * заданные.
 */
export function serializeHistoryFilters(state: HistoryFilterState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('period', state.period);
  // TASK-046 §5: даты custom — как есть (валидность гарантирует парсер/UI).
  if (state.period === 'custom') {
    if (state.from !== undefined) {
      params.set('from', state.from);
    }
    if (state.to !== undefined) {
      params.set('to', state.to);
    }
  }
  if (state.arm !== undefined) {
    params.set('arm', state.arm);
  }
  if (state.noted === true) {
    params.set('noted', '1');
  }
  // TASK-045 §5: q — как есть (непустоту гарантирует парсер/хук).
  if (state.q !== undefined) {
    params.set('q', state.q);
  }
  return params;
}

/** Отлично ли состояние от дефолта (§10: пустой результат при активных фильтрах — особое состояние). */
export function isFiltersActive(state: HistoryFilterState): boolean {
  return (
    state.period !== DEFAULT_FILTER_STATE.period ||
    state.arm !== undefined ||
    state.noted === true ||
    state.q !== undefined
  );
}

/**
 * TASK-045 §10: клиентское сужение результата поиска фильтрами периода/руки/заметок.
 * Поиск (notes/search) возвращает записи по всей БД — фильтры поверх применяются в
 * renderer. Семантика — та же, что у фрагмента запроса list: границы включительно
 * (прецедент порта TASK-021), hasNote=true → заметка есть.
 */
export function matchesDtoFilters(
  fragment: MeasurementQueryFragment,
  dto: Pick<MeasurementDto, 'takenAtUtcMs' | 'arm' | 'note'>,
): boolean {
  if (fragment.fromUtcMs !== undefined && dto.takenAtUtcMs < fragment.fromUtcMs) {
    return false;
  }
  if (fragment.toUtcMs !== undefined && dto.takenAtUtcMs > fragment.toUtcMs) {
    return false;
  }
  if (fragment.arm !== undefined && dto.arm !== fragment.arm) {
    return false;
  }
  if (fragment.hasNote === true && dto.note === undefined) {
    return false;
  }
  return true;
}
