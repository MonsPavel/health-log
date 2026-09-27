/**
 * TASK-044 §5/§10/§16: панель фильтров истории и хук useMeasurementFilters.
 *
 * Компонент — презентационный (§16: значения — проп-состояние, события —
 * колбэки): сегмент-контрол периода на нативных radio в fieldset/legend
 * (прецедент ArmSegment TASK-031), «Произвольный» — disabled-заглушка до
 * TASK-046 (§5) с пояснением в title; select руки и чекбокс «Только с
 * заметками» с label; кнопка сброса. Панель НЕ размонтируется при смене
 * фильтров/данных (HistoryScreen держит её в списке всегда) — фокус остаётся
 * на контроле (§16).
 *
 * Хук (§5/§12/§13): URL — источник истины. useSearchParams читается парсером
 * модели (мусор → дефолт, §14); «сейчас» для границ пресета фиксируется в
 * момент применения (memo по канонической строке URL — не на каждый рендер,
 * §13); каждое применение переписывает URL сериализатором (replace — фильтры
 * не засоряют историю навигации); reset возвращает ?period=30d (§5).
 *
 * Ключи каталога — литералы в картах (§22: динамических ключей нет, прецедент
 * NOTICE_KEY/ARM_KEY TASK-038/031 — check-i18n ищет полные литералы).
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import {
  DEFAULT_FILTER_STATE,
  isFiltersActive,
  parseHistoryFilters,
  serializeHistoryFilters,
  toQuery,
  type HistoryArm,
  type HistoryFilterState,
  type HistoryPeriod,
  type MeasurementQueryFragment,
} from '../model/filters';

/** Пункты сегмента периода (§17: ключи filters.period.*, custom — заглушка). */
const PERIOD_OPTIONS = ['7d', '30d', '90d', 'all', 'custom'] as const;

/** Ключи подписей периода — литералы в карте (§22). */
const PERIOD_KEY: Readonly<
  Record<
    HistoryPeriod,
    | 'measurement.filters.period.7d'
    | 'measurement.filters.period.30d'
    | 'measurement.filters.period.90d'
    | 'measurement.filters.period.all'
    | 'measurement.filters.period.custom'
  >
> = {
  '7d': 'measurement.filters.period.7d',
  '30d': 'measurement.filters.period.30d',
  '90d': 'measurement.filters.period.90d',
  all: 'measurement.filters.period.all',
  custom: 'measurement.filters.period.custom',
};

/** Варианты фильтра руки (§17: filters.arm.any/left/right) — литералы ключей (§22). */
const ARM_OPTIONS: Readonly<
  {
    value: 'any' | 'left' | 'right';
    key:
      | 'measurement.filters.arm.any'
      | 'measurement.filters.arm.left'
      | 'measurement.filters.arm.right';
  }[]
> = [
  { value: 'any', key: 'measurement.filters.arm.any' },
  { value: 'left', key: 'measurement.filters.arm.left' },
  { value: 'right', key: 'measurement.filters.arm.right' },
];

/** Props панели: контролируемое состояние + колбэки применения (§5). */
export interface HistoryFiltersProps {
  /** Текущее состояние фильтров (URL-восстановлено хуком). */
  readonly state: HistoryFilterState;
  /** Выбор пресета периода (custom недостижим — радио disabled). */
  readonly onPeriod: (period: Exclude<HistoryPeriod, 'custom'>) => void;
  /** Выбор руки; undefined — «все». */
  readonly onArm: (arm: HistoryArm | undefined) => void;
  /** Переключение «только с заметками». */
  readonly onNoted: (noted: boolean) => void;
  /** Сброс к дефолту (?period=30d, §5). */
  readonly onReset: () => void;
}

/** Панель фильтров над историей (§2): период, рука, заметки, сброс. */
export function HistoryFilters({
  state,
  onPeriod,
  onArm,
  onNoted,
  onReset,
}: HistoryFiltersProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="history-filters"
      className="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3 rounded-md border border-border p-3"
    >
      <fieldset className="border-0 p-0">
        <legend className="text-sm text-accent">{t('measurement.filters.periodLabel')}</legend>
        <div className="flex gap-2">
          {PERIOD_OPTIONS.map((period) => {
            const isCustomStub = period === 'custom';
            return (
              <label
                key={period}
                title={isCustomStub ? t('measurement.filters.customStub') : undefined}
                className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-base hover:bg-accent/10 data-disabled:cursor-default data-disabled:opacity-50"
                data-disabled={isCustomStub ? 'true' : undefined}
              >
                <input
                  type="radio"
                  name="history-period"
                  data-testid={`filter-period-${period}`}
                  value={period}
                  checked={state.period === period}
                  disabled={isCustomStub}
                  onChange={() => {
                    if (period !== 'custom') {
                      onPeriod(period);
                    }
                  }}
                  className="h-5 w-5 accent-[var(--hl-accent)]"
                />
                {t(PERIOD_KEY[period])}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-arm" className="text-sm text-accent">
          {t('measurement.filters.armLabel')}
        </label>
        <select
          id="filter-arm"
          data-testid="filter-arm"
          value={state.arm ?? 'any'}
          onChange={(event) => {
            const value = event.target.value;
            onArm(value === 'left' || value === 'right' ? value : undefined);
          }}
          className="min-h-11 rounded-md border border-border bg-transparent px-3 py-2 text-base"
        >
          {ARM_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.key)}
            </option>
          ))}
        </select>
      </div>

      <label
        htmlFor="filter-noted"
        className="flex min-h-11 cursor-pointer items-center gap-2 text-base"
      >
        <input
          type="checkbox"
          id="filter-noted"
          data-testid="filter-noted"
          checked={state.noted === true}
          onChange={(event) => onNoted(event.target.checked)}
          className="h-5 w-5 accent-[var(--hl-accent)]"
        />
        {t('measurement.filters.noted')}
      </label>

      <button
        type="button"
        data-testid="filters-reset"
        onClick={onReset}
        className="min-h-11 rounded-md border border-border px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {t('measurement.filters.reset')}
      </button>
    </div>
  );
}

/** Публичный API хука фильтров: состояние, query, активность и применения (§5). */
export interface MeasurementFilters {
  /** Состояние из URL (мусор → дефолт, §14). */
  readonly state: HistoryFilterState;
  /** Фрагмент MeasurementListRequest для запроса list / ключа кэша (§12). */
  readonly query: MeasurementQueryFragment;
  /** Отличается ли состояние от дефолта (§10: особое пустое состояние). */
  readonly isActive: boolean;
  /** Выбор пресета периода — момент клика фиксирует «сейчас» границы (§13). */
  readonly setPeriod: (period: Exclude<HistoryPeriod, 'custom'>) => void;
  /** Выбор руки (undefined — «все», параметр из URL убирается). */
  readonly setArm: (arm: HistoryArm | undefined) => void;
  /** Переключение «только с заметками» (false — параметр убирается). */
  readonly setNoted: (noted: boolean) => void;
  /** Сброс к дефолту: URL → ?period=30d (§5). */
  readonly reset: () => void;
}

/**
 * Хук фильтров истории (§5): парсит URL, считает query-фрагмент и отдаёт
 * применяющие колбэки. Границы пресета (§13) считаются от now, зафиксированного
 * на изменение URL (memo по канонической строке поиска): перерисовки списка
 * границу не двигают — «последние 7 дней» остаются моментом применения.
 */
export function useMeasurementFilters(): MeasurementFilters {
  const [searchParams, setSearchParams] = useSearchParams();
  // Каноническая строка URL — ключ «применения»: новая строка = новое «сейчас».
  // Зависимость memo — search (строка), а не объект searchParams: состояние и
  // query референтно стабильны между перерисовками с тем же URL.
  const search = searchParams.toString();
  const state = useMemo(() => parseHistoryFilters(searchParams), [search]);
  const nowUtcMs = useMemo(() => Date.now(), [search]);
  const query = useMemo(() => toQuery(state, nowUtcMs), [state, nowUtcMs]);

  const apply = useCallback(
    (next: HistoryFilterState) => {
      setSearchParams(serializeHistoryFilters(next), { replace: true });
    },
    [setSearchParams],
  );

  const setPeriod = useCallback(
    (period: Exclude<HistoryPeriod, 'custom'>) => apply({ ...state, period }),
    [apply, state],
  );
  const setArm = useCallback(
    (arm: HistoryArm | undefined) => apply({ ...state, arm }),
    [apply, state],
  );
  const setNoted = useCallback((noted: boolean) => apply({ ...state, noted }), [apply, state]);
  const reset = useCallback(() => apply(DEFAULT_FILTER_STATE), [apply]);

  return { state, query, isActive: isFiltersActive(state), setPeriod, setArm, setNoted, reset };
}
