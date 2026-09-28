/**
 * TASK-044 §7/§13/§14: чистая модель фильтров истории — состояние ↔ URL ↔ query.
 *
 * TASK-057 §4/§5/§6 (перенос в общий lib): период-часть утилит (тип периода,
 * DAY_MS, календарная математика range, парсер/сериализатор периода URL) —
 * ПЕРЕНЕСЕНА в src-renderer/lib/period.ts (один паттерн period по продукту:
 * журнал и экран «Динамика» используют одни и те же URL-семантики TASK-044/046).
 * Здесь — реэкспорт перенесённого (§6: «реэкспорт утилит фильтров», публичное
 * API не меняется) + журнальная специфика: рука/заметки/поиск (arm/noted/q).
 *
 * Состояние (§7): HistoryFilterState {period, from?, to?, arm?, noted?, q?}.
 * TASK-046 custom: period='custom' — произвольный диапазон с настенными датами
 * from/to ('YYYY-MM-DD', ISO). Границы запроса (§13) считаются periodToBounds
 * (lib/period): from = полночь настенного дня, to = 23:59:59.999 настенного дня
 * включительно — записи включаются по настенному дню измерения (согласовано с
 * группировкой TASK-033). Неполный диапазон — открытая сторона (§10
 * прогрессивно: только from → «от даты до ∞»); пустые оба и невалидные даты →
 * границы дефолтного 30d (§10/§14), режим custom в URL при этом сохраняется —
 * поля остаются видимы.
 *
 * URL (§3/§12): источник истины фильтров — сериализуем и шаро-пригоден.
 * Сериализатор всегда пишет period (дефолт 30d виден в адресе — сброс даёт
 * `?period=30d`, §5); custom добавляет from/to (§5: `period=custom&from=&to=`),
 * arm/noted — только непустые (`noted=1`). Парсер строгий: неизвестные значения
 * → дефолт; from/to читаются только при period=custom, строгий ISO-календарь
 * (parseIsoDate), мусор отбрасывается, from > to — весь custom мусорен →
 * дефолт (мусор URL не выдаёт ошибок и не доходит до запроса list, §14);
 * посторонние параметры игнорируются. to-в-будущем парсер не видит (нужен now) —
 * отсекается toQuery (parseRange futureTo → дефолт 30d, EC-20).
 */
import type { MeasurementDto, MeasurementListRequest } from '@hl/contracts';

import {
  parsePeriodState,
  periodToBounds,
  serializePeriodState,
  type ParamsReader,
  type PeriodState,
} from '../../../lib/period';

/**
 * Реэкспорт перенесённого в lib/period (§6 057): публичное API журнала 044/046
 * сохранено — существующие импорты (HistoryPeriod, DAY_MS, parseIsoDate,
 * parseRange) работают без изменений.
 */
export {
  DAY_MS,
  MS_PER_MINUTE,
  parseIsoDate,
  parseRange,
  periodToBounds,
  type CalendarDate,
  type ParseRangeResult,
  type RangeBounds,
  type RangeErrorKind,
} from '../../../lib/period';
export type { Period as HistoryPeriod } from '../../../lib/period';

/** Рука фильтра — те же значения, что ArmSchema контрактов (§4). */
export type HistoryArm = MeasurementListRequest['arm'];

/** Состояние панели фильтров (§7): URL-восстановимо, дефолт — 30d. TASK-045: + q. */
export interface HistoryFilterState extends PeriodState {
  readonly arm?: HistoryArm;
  readonly noted?: boolean;
  /** Строка поиска по заметкам (§5: URL ?q=); пустой/пробельный ввод — параметра нет. */
  readonly q?: string;
}

/** Дефолтное состояние фильтров (§5: сброс → URL `?period=30d`). */
export const DEFAULT_FILTER_STATE: HistoryFilterState = { period: '30d' };

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
 * Состояние → фрагмент запроса list (§7): чистая функция; границы периода —
 * periodToBounds (lib/period: пресеты от переданного nowUtcMs — момент
 * применения фиксирует вызывающий, custom — настенные дни), рука/hasNote —
 * как есть.
 */
export function toQuery(state: HistoryFilterState, nowUtcMs: number): MeasurementQueryFragment {
  const tail = {
    ...(state.arm === undefined ? {} : { arm: state.arm }),
    ...(state.noted === true ? { hasNote: true } : {}),
  };
  const bounds = periodToBounds(state, nowUtcMs);
  return {
    ...(bounds.fromUtcMs === undefined ? {} : { fromUtcMs: bounds.fromUtcMs }),
    ...(bounds.toUtcMs === undefined ? {} : { toUtcMs: bounds.toUtcMs }),
    ...tail,
  };
}

/**
 * Парсер URL → состояние (§7/§14): период-часть — parsePeriodState (lib/period:
 * мусор → дефолт, from/to только при custom, from > to → дефолт), поверх —
 * журнальные arm/noted/q; TASK-045 §10: q — поисковая строка; пустая/пробельная
 * считается отсутствующей (поиск не активен), непустая — хранится как есть
 * (trim делает хук поиска).
 */
export function parseHistoryFilters(params: ParamsReader): HistoryFilterState {
  const arm = params.get('arm');
  const noted = params.get('noted');
  const q = params.get('q');
  const validQ = q !== null && q.trim() !== '' ? q : undefined;
  const validArm: HistoryArm | undefined = arm === 'left' || arm === 'right' ? arm : undefined;
  return {
    ...parsePeriodState(params),
    ...(validArm === undefined ? {} : { arm: validArm }),
    ...(noted === '1' ? { noted: true } : {}),
    ...(validQ === undefined ? {} : { q: validQ }),
  };
}

/**
 * Состояние → URLSearchParams (§12): период-часть — serializePeriodState
 * (lib/period: период всегда, from/to — при custom), arm/noted — только заданные.
 */
export function serializeHistoryFilters(state: HistoryFilterState): URLSearchParams {
  const params = serializePeriodState(state);
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
