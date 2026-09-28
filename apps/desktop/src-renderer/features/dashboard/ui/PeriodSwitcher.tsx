/**
 * TASK-057 §5/§12: период-контрол экрана «Динамика» — 7д/30д/90д/всё/произвольный.
 * Переиспользование семантик TASK-044/046 (§4: «один паттерн period по продукту»):
 * состояние — lib/period (PeriodState), поля произвольного диапазона —
 * CustomRangeFields измерения, ключи каталога — measurement.filters.* (те же
 * подписи, что у журнала — проверяет check-i18n по общему использованию).
 *
 * Компонент презентационный (§16, прецедент HistoryFilters TASK-044): сегмент на
 * нативных radio в fieldset/legend (прецедент ArmSegment/HistoryFilters), «Произвольный»
 * включает CustomRangeFields — invalid-ввод блокируется внутри него (§19 046), в URL
 * уходят лишь валидные даты.
 *
 * Хук useDashboardPeriod (§12): URL — источник истины. useSearchParams читается
 * parsePeriodState (мусор → дефолт, §14); «сейчас» для границ custom фиксируется
 * на изменение URL (memo по канонической строке — не на каждый рендер, §13 044);
 * каждое применение переписывает URL сериализатором (replace — периоды не засоряют
 * историю навигации); periodToStatsParam отдаёт период каналов trend/stats
 * (пресет строкой — границы считает main от Clock; custom — utcMs-границы).
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import type { StatsPeriodParam } from '@hl/contracts';

import {
  parsePeriodState,
  periodToStatsParam,
  serializePeriodState,
  type Period,
  type PeriodState,
} from '../../../lib/period';
import { CustomRangeFields } from '../../measurement/ui/CustomRangeFields';

/** Пункты сегмента периода (§5: пресеты 044 + custom 046) — ключи-литералы (§22). */
const PERIOD_OPTIONS = ['7d', '30d', '90d', 'all', 'custom'] as const;

/** Ключи подписей периода (общие с журналом — один паттерн period, §4 057). */
const PERIOD_KEY: Readonly<
  Record<
    Period,
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

/** Props панели периода (§5): контролируемое состояние + колбэки применения. */
export interface PeriodSwitcherProps {
  /** Текущее состояние периода (URL-восстановлено хуком). */
  readonly state: PeriodState;
  /** Выбор периода — пресет или «Произвольный». */
  readonly onPeriod: (period: Period) => void;
  /** Применение валидного диапазона custom (§5 046; invalid блокирует CustomRangeFields). */
  readonly onRange: (from: string | undefined, to: string | undefined) => void;
}

/** Сегмент периода над графиком (§2): 7д/30д/90д/всё/произвольный. */
export function PeriodSwitcher({ state, onPeriod, onRange }: PeriodSwitcherProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <fieldset data-testid="dashboard-period" className="mb-4 border-0 p-0">
      <legend className="text-sm text-accent">{t('measurement.filters.periodLabel')}</legend>
      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((period) => (
          <label
            key={period}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-base hover:bg-accent/10"
          >
            <input
              type="radio"
              name="dashboard-period"
              data-testid={`dashboard-period-${period}`}
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
  );
}

/** Публичный API периода дашборда (§5): состояние, период канала, применения. */
export interface DashboardPeriod {
  /** Состояние из URL (мусор → дефолт, §14). */
  readonly state: PeriodState;
  /** Период каналов trend/series и stats/period (StatsPeriodParam, §11). */
  readonly param: StatsPeriodParam;
  /** Выбор периода — пресет или «Произвольный»; момент клика фиксирует «сейчас» (§13). */
  readonly setPeriod: (period: Period) => void;
  /** Применение валидного диапазона custom (§5 046; undefined — поле не задано). */
  readonly setRange: (from: string | undefined, to: string | undefined) => void;
}

/**
 * Хук периода дашборда (§12): URL — источник истины; применённое состояние →
 * период канала (periodToStatsParam); применения переписывают URL (replace).
 * «Произвольный» сохраняет уже введённый диапазон (возврат с пресета
 * восстанавливает поля — §5 046, прецедент setPeriod useMeasurementFilters).
 */
export function useDashboardPeriod(): DashboardPeriod {
  const [searchParams, setSearchParams] = useSearchParams();
  // Каноническая строка URL — ключ «применения»: новая строка = новое «сейчас»
  // (§13 044: перерисовки границу не двигают; state/param референтно стабильны).
  const search = searchParams.toString();
  const state = useMemo(() => parsePeriodState(searchParams), [search]);
  const nowUtcMs = useMemo(() => Date.now(), [search]);
  const param = useMemo(() => periodToStatsParam(state, nowUtcMs), [state, nowUtcMs]);

  const apply = useCallback(
    (next: PeriodState) => {
      setSearchParams(serializePeriodState(next), { replace: true });
    },
    [setSearchParams],
  );

  // §5 046: уход на пресет даты убирает (from/to — параметры режима custom);
  // «Произвольный» возвращается с сохранённым диапазоном (поля остаются видимы).
  const setPeriod = useCallback(
    (period: Period) => {
      if (period === 'custom') {
        apply({ ...state, period: 'custom' });
        return;
      }
      apply({ period });
    },
    [apply, state],
  );
  const setRange = useCallback(
    (from: string | undefined, to: string | undefined) => {
      apply({
        period: 'custom',
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
    },
    [apply],
  );

  return { state, param, setPeriod, setRange };
}
