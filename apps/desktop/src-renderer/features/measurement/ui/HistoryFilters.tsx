/**
 * TASK-044 §5/§10/§16: панель фильтров истории и хук useMeasurementFilters.
 *
 * Компонент — презентационный (§16: значения — проп-состояние, события —
 * колбэки): сегмент-контрол периода на нативных radio в fieldset/legend
 * (прецедент ArmSegment TASK-031); «Произвольный» (TASK-046 §5) включает
 * CustomRangeFields — два нативных date-input «С»/«По» с валидацией; select
 * руки и чекбокс «Только с заметками» с label; кнопка сброса. Панель НЕ
 * размонтируется при смене фильтров/данных (HistoryScreen держит её в списке
 * всегда) — фокус остаётся на контроле (§16).
 *
 * Хук (§5/§12/§13): URL — источник истины. useSearchParams читается парсером
 * модели (мусор → дефолт, §14); «сейчас» для границ пресета/диапазона
 * фиксируется в момент применения (memo по канонической строке URL — не на
 * каждый рендер, §13); каждое применение переписывает URL сериализатором
 * (replace — фильтры не засоряют историю навигации); reset возвращает
 * ?period=30d (§5). setRange (TASK-046) применяет только валидные даты —
 * invalid-состояние блокируется в CustomRangeFields (§19); setPeriod('custom')
 * сохраняет введённый диапазон (возврат на пресет и обратно), уход на пресет
 * даты убирает.
 *
 * Ключи каталога — литералы в картах (§22: динамических ключей нет, прецедент
 * NOTICE_KEY/ARM_KEY TASK-038/031 — check-i18n ищет полные литералы).
 *
 * TASK-045 §5/§10/§12/§16: строка поиска по заметкам (type="search" с label, §16).
 * Черновик ввода — локальное состояние компонента; применение в URL — через
 * debounce 300 мс (§10, SEARCH_DEBOUNCE_MS): каждое нажатие клавиши не переписывает
 * адрес и не создаёт ключи кэша. Esc очищает поле и применяет пустой запрос
 * немедленно (§16); ×-кнопка — то же (§10). Внешняя смена state.q (сброс фильтров)
 * синхронизирует черновик.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { SEARCH_DEBOUNCE_MS } from '../api/use-notes-search';
import { CustomRangeFields } from './CustomRangeFields';

/** Пункты сегмента периода (§17: ключи filters.period.*; custom — TASK-046). */
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
  /** Выбор периода — пресет или «Произвольный» (TASK-046 §5). */
  readonly onPeriod: (period: HistoryPeriod) => void;
  /** Выбор руки; undefined — «все». */
  readonly onArm: (arm: HistoryArm | undefined) => void;
  /** Переключение «только с заметками». */
  readonly onNoted: (noted: boolean) => void;
  /** Применение поискового запроса (после debounce; '' — очистка, §5 TASK-045). */
  readonly onQuery: (query: string) => void;
  /** Применение валидного диапазона custom (§5 TASK-046; invalid блокирует CustomRangeFields). */
  readonly onRange: (from: string | undefined, to: string | undefined) => void;
  /** Сброс к дефолту (?period=30d, §5). */
  readonly onReset: () => void;
}

/** Панель фильтров над историей (§2): период, рука, заметки, поиск, сброс. */
export function HistoryFilters({
  state,
  onPeriod,
  onArm,
  onNoted,
  onQuery,
  onRange,
  onReset,
}: HistoryFiltersProps): JSX.Element {
  const { t } = useTranslation();
  // TASK-045 §10/§12: черновик поисковой строки — локально; в URL — после debounce.
  const [queryDraft, setQueryDraft] = useState(state.q ?? '');
  // Внешняя смена состояния (сброс фильтров, ссылка с ?q=) синхронизирует черновик.
  useEffect(() => {
    setQueryDraft(state.q ?? '');
  }, [state.q]);
  // Debounce применения (§10): таймер перезапускается на каждое изменение черновика.
  useEffect(() => {
    if (queryDraft === (state.q ?? '')) {
      return undefined;
    }
    const timer = setTimeout(() => onQuery(queryDraft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryDraft, state.q, onQuery]);
  // Очистка (Esc/×, §10/§16): немедленно, без ожидания debounce.
  const clearQuery = useCallback(() => {
    setQueryDraft('');
    onQuery('');
  }, [onQuery]);

  return (
    <div
      data-testid="history-filters"
      className="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3 rounded-md border border-border p-3"
    >
      <fieldset className="border-0 p-0">
        <legend className="text-sm text-accent">{t('measurement.filters.periodLabel')}</legend>
        <div className="flex gap-2">
          {PERIOD_OPTIONS.map((period) => (
            <label
              key={period}
              className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-base hover:bg-accent/10 data-disabled:cursor-default data-disabled:opacity-50"
            >
              <input
                type="radio"
                name="history-period"
                data-testid={`filter-period-${period}`}
                value={period}
                checked={state.period === period}
                onChange={() => onPeriod(period)}
                className="h-5 w-5 accent-[var(--hl-accent)]"
              />
              {t(PERIOD_KEY[period])}
            </label>
          ))}
        </div>
        {/* TASK-046 §5/§10: поля произвольного периода — только в режиме custom;
            invalid-ввод блокируется внутри (§19), в URL уходят лишь валидные даты. */}
        {state.period === 'custom' && (
          <div className="mt-3">
            <CustomRangeFields from={state.from} to={state.to} onApply={onRange} />
          </div>
        )}
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

      <div className="flex flex-col gap-1">
        {/* TASK-045 §16: label + type="search"; Esc очищает (§16), ×-кнопка — тоже (§10). */}
        <label htmlFor="filter-query" className="text-sm text-accent">
          {t('measurement.search.placeholder')}
        </label>
        <div className="flex items-center gap-1">
          <input
            id="filter-query"
            type="search"
            data-testid="filter-query"
            value={queryDraft}
            placeholder={t('measurement.search.placeholder')}
            onChange={(event) => setQueryDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                clearQuery();
              }
            }}
            className="min-h-11 w-56 rounded-md border border-border bg-transparent px-3 py-2 text-base"
          />
          {queryDraft !== '' && (
            <button
              type="button"
              data-testid="filter-query-clear"
              aria-label={t('measurement.search.clear')}
              onClick={clearQuery}
              className="min-h-11 min-w-11 rounded-md border border-border px-3 text-base hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              ×
            </button>
          )}
        </div>
      </div>

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
  /** Выбор периода — пресет или «Произвольный»; момент клика фиксирует «сейчас» границ (§13). */
  readonly setPeriod: (period: HistoryPeriod) => void;
  /** Выбор руки (undefined — «все», параметр из URL убирается). */
  readonly setArm: (arm: HistoryArm | undefined) => void;
  /** Переключение «только с заметками» (false — параметр убирается). */
  readonly setNoted: (noted: boolean) => void;
  /** Применение поискового запроса (TASK-045): '' — параметр q убирается. */
  readonly setQuery: (query: string) => void;
  /** Применение валидного диапазона custom (TASK-046 §5; undefined — поле не задано). */
  readonly setRange: (from: string | undefined, to: string | undefined) => void;
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

  // TASK-046 §5: «Произвольный» сохраняет уже введённый диапазон (возврат с
  // пресета восстанавливает поля); уход на пресет даты убирает (параметры
  // from/to — только режима custom, §5).
  const setPeriod = useCallback(
    (period: HistoryPeriod) => {
      if (period === 'custom') {
        apply({ ...state, period: 'custom' });
        return;
      }
      const { arm, noted, q } = state;
      apply({
        period,
        ...(arm === undefined ? {} : { arm }),
        ...(noted === true ? { noted } : {}),
        ...(q === undefined ? {} : { q }),
      });
    },
    [apply, state],
  );
  const setArm = useCallback(
    (arm: HistoryArm | undefined) => apply({ ...state, arm }),
    [apply, state],
  );
  const setNoted = useCallback((noted: boolean) => apply({ ...state, noted }), [apply, state]);
  // TASK-045 §5/§12: применённый запрос живёт в URL (?q=); пустой — параметр убирается.
  const setQuery = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      apply({ ...state, ...(trimmed === '' ? { q: undefined } : { q: trimmed }) });
    },
    [apply, state],
  );
  // TASK-046 §5/§12: диапазон custom в URL (period=custom&from=&to=); оба поля
  // пустые — режим custom без дат (§10: границы 30d); спредом из state старые
  // даты не тащим — убранные поля обязаны исчезнуть из адреса.
  const setRange = useCallback(
    (from: string | undefined, to: string | undefined) => {
      const { arm, noted, q } = state;
      apply({
        period: 'custom',
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(arm === undefined ? {} : { arm }),
        ...(noted === true ? { noted } : {}),
        ...(q === undefined ? {} : { q }),
      });
    },
    [apply, state],
  );
  const reset = useCallback(() => apply(DEFAULT_FILTER_STATE), [apply]);

  return {
    state,
    query,
    isActive: isFiltersActive(state),
    setPeriod,
    setArm,
    setNoted,
    setQuery,
    setRange,
    reset,
  };
}
