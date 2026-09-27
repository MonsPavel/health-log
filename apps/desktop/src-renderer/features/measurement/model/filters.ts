/**
 * TASK-044 §7/§13/§14: чистая модель фильтров истории — состояние ↔ URL ↔ query.
 *
 * Состояние (§7): HistoryFilterState {period, arm?, noted?}; custom — элемент
 * типа, зарезервированный под произвольный диапазон TASK-046 (§23): UI его не
 * создаёт, toQuery границ не даёт, парсер в URL его не восстанавливает —
 * встреченный в адресе custom (старая ссылка/рука будущего) считается мусором и
 * даёт дефолт, как и любой невалидный период (§14).
 *
 * Границы пресета (§13): fromUtcMs = nowUtcMs − N*86400000 ВКЛЮЧИТЕЛЬНО —
 * запись ровно на границе 7 дней попадает в выборку (включительные границы
 * порта — TASK-021); «всё» → from отсутствует. nowUtcMs передаётся параметром —
 * момент применения фиксирует вызывающий (хук useMeasurementFilters), не
 * каждый рендер.
 *
 * URL (§3/§12): источник истины фильтров — сериализуем и шаро-пригоден.
 * Сериализатор всегда пишет period (дефолт 30d виден в адресе — сброс даёт
 * `?period=30d`, §5); arm/noted — только непустые (`noted=1`). Парсер строгий:
 * неизвестные значения → дефолт (мусор URL не выдаёт ошибок и не доходит до
 * запроса list, §14), посторонние параметры игнорирует.
 */
import type { MeasurementListRequest } from '@hl/contracts';

/** Период пресета (§7); custom — заглушка до TASK-046. */
export type HistoryPeriod = '7d' | '30d' | '90d' | 'all' | 'custom';

/** Рука фильтра — те же значения, что ArmSchema контрактов (§4). */
export type HistoryArm = MeasurementListRequest['arm'];

/** Состояние панели фильтров (§7): URL-восстановимо, дефолт — 30d. */
export interface HistoryFilterState {
  readonly period: HistoryPeriod;
  readonly arm?: HistoryArm;
  readonly noted?: boolean;
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
 */
export function toQuery(state: HistoryFilterState, nowUtcMs: number): MeasurementQueryFragment {
  const days =
    state.period === 'all' || state.period === 'custom' ? undefined : PERIOD_DAYS[state.period];
  return {
    ...(days === undefined ? {} : { fromUtcMs: nowUtcMs - days * DAY_MS }),
    ...(state.arm === undefined ? {} : { arm: state.arm }),
    ...(state.noted === true ? { hasNote: true } : {}),
  };
}

/** Минимальная поверхность чтения параметров (URLSearchParams и ReadonlyURLSearchParams роутера). */
interface ParamsReader {
  get(name: string): string | null;
}

/** Периоды, валидные в URL; custom появится с поддержкой from/to (TASK-046, §23). */
const URL_PERIODS = ['7d', '30d', '90d', 'all'] as const;

/** Парсер URL → состояние (§7/§14): мусор в любом поле → дефолт этого поля. */
export function parseHistoryFilters(params: ParamsReader): HistoryFilterState {
  const period = params.get('period');
  const arm = params.get('arm');
  const noted = params.get('noted');
  const validPeriod = URL_PERIODS.find((candidate) => candidate === period);
  const validArm: HistoryArm | undefined = arm === 'left' || arm === 'right' ? arm : undefined;
  return {
    period: validPeriod ?? DEFAULT_FILTER_STATE.period,
    ...(validArm === undefined ? {} : { arm: validArm }),
    ...(noted === '1' ? { noted: true } : {}),
  };
}

/**
 * Состояние → URLSearchParams (§12): period всегда (дефолт виден в адресе),
 * arm/noted — только заданные. Для period='custom' пишет значение как есть —
 * парсер его пока свёл бы к дефолту; UI custom не создаёт (§23 — TASK-046).
 */
export function serializeHistoryFilters(state: HistoryFilterState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('period', state.period);
  if (state.arm !== undefined) {
    params.set('arm', state.arm);
  }
  if (state.noted === true) {
    params.set('noted', '1');
  }
  return params;
}

/** Отлично ли состояние от дефолта (§10: пустой результат при активных фильтрах — особое состояние). */
export function isFiltersActive(state: HistoryFilterState): boolean {
  return (
    state.period !== DEFAULT_FILTER_STATE.period || state.arm !== undefined || state.noted === true
  );
}
