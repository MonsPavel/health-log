/**
 * TASK-057 §2/§5/§10/§11/§12: экран «Динамика» (/dashboard) — главный экран
 * понимания тренда (US-10): график СДА/ДДА с опорными линиями справочных
 * значений и подписью источника шкалы, точки различают утро/вечер формой+цветом,
 * переключатели периода 7д/30д/90д/всё/произвольный (URL `?period=` — истина,
 * §12), тултип с точными значениями и переходом к правке записи.
 *
 * TASK-058 §2/§5/§12: переключатель вида «Давление/Пульс» — URL `?view=` —
 * истина (дефолт pressure, мусор → дефолт); график ЧСС (PulseChart) рендерится
 * из ТОГО ЖЕ ответа trend/series (§15: второй запрос не нужен — кэш общий,
 * переключение мгновенно); шкала графику ЧСС не нужна (опорный коридор —
 * константы контракта). Переход к правке — тот же openEdit (§5).
 *
 * TASK-059 §2/§5/§12/§13/§16: переключатель «График/Таблица» — URL `?as=chart|
 * table` — истина (дефолт chart, мусор → дефолт); таблица (TrendTable) строится
 * из ТОГО ЖЕ TrendResponse (ленивый монтаж — §15), резюме тренда (TrendSummary)
 * и aria-метка графика — из ЕДИНОГО stats/period-ответа (useStats; §13: «резюме-
 * числа == числа таблицы == числа графика — одни read models», тест-сверка на
 * фикстуре). В режиме таблицы сегмент «Давление/Пульс» скрыт (на таблицу не
 * влияет; возврат к графику восстанавливает вид из URL). Live-инвалидация
 * measurement:changed накрывает и ['stats'] — резюме тоже свежие (§10).
 *
 * Данные (§11): useTrend (trend/series — режим raw/daily решает read model 056)
 * и useActiveScale (scales/active — опорные линии ИЗ ДАННЫХ шкалы, не хардкод).
 * Период (§12): useDashboardPeriod (lib/period — те же URL-семантики, что у
 * журнала TASK-044/046; custom → utcMs-границы periodToStatsParam).
 *
 * Состояния (§10): loading — скелетон-оси; empty — обучающая заглушка
 * EmptyChartState TASK-060 («За выбранный период измерений нет» + CTA «Добавить
 * измерение» → журнал + «Показать всё время» → период all, §5); error —
 * тост + «Повторить» (прецедент HistoryScreen); данные — график + легенда
 * (+ мини-таблица клавиатуры в raw, §16). daily — подпись «агрегировано по дням»
 * (честность, §10) — внутри графика.
 *
 * TASK-060 §5/§13/§16: пустые/мало-данные состояния — ветвление по trend/stats
 * (§4: данные уже загружены, без дополнительных запросов). Пустой период —
 * N=0 (raw: points.length; daily: Σdays.count — точки в daily отсутствуют) —
 * EmptyChartState в ОБОИХ режимах. Мало данных (1≤N<AI_MIN_MEASUREMENTS=7) —
 * FewDataNote НАД графиком (график рендерится, §5) + в режиме таблицы пометки
 * нет (§5: полоса над графиком). ПОРОГ — из kernel-константы (единый источник
 * с ИИ-честностью TASK-006): рендерер kernel не импортирует (арх. 03 §4) —
 * флаг приходит готовым из stats/period (tooFewMeasurements = N<7 считает main,
 * period-statistics.ts); число в пометке — count ТОГО ЖЕ stats-ответа, что и
 * флаг (никогда не расходятся; §13: одни read models). Отказ stats — пометка
 * просто не показывается, график из trend остаётся (§10, прецедент резюме 059).
 *
 * Переход к правке (§12): точка (тултип/клик/строка мини-таблицы) → полный DTO
 * через measurements/list с границами utc записи (from=to=utcMs — список вернёт
 * записи ровно этого момента; id точки записан в RawPoint — дополнение контракта
 * §12) → form-store.startEdit(dto) (TASK-038 edit-режим) → navigate('/journal'),
 * где HistoryScreen открывает форму в режиме правки (editingId ≠ null).
 * daily-режим правки не имеет (агрегат, §12) — у точек daily колбэка нет.
 *
 * Live (§10): useHlEvent('measurement:changed') → инвалидация ['trend', profileId]
 * (частичный ключ матчит все периоды — §12; данные свежие после ввода).
 */
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { APP_INTERNAL_ERROR } from '@hl/contracts';
import type { RawPoint, TrendResponse } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import { useHlEvent } from '../../../lib/events';
import { call } from '../../../src/lib/ipc';
import { IpcApiError, PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { HISTORY_PAGE_LIMIT } from '../../measurement/api/use-measurements';
import { useFormStore } from '../../measurement/model/form-store';
import { useActiveScale } from '../api/use-active-scale';
import { STATS_KEY_ROOT, useStats } from '../api/use-stats';
import { TREND_KEY_ROOT, useTrend } from '../api/use-trend';
import { EmptyChartState } from './EmptyChartState';
import { FewDataNote } from './FewDataNote';
import { PulseChart } from './PulseChart';
import { useDashboardPeriod } from './PeriodSwitcher';
import { PeriodSwitcher } from './PeriodSwitcher';
import { TrendChart } from './TrendChart';
import { formatNumberRu, TrendSummary } from './TrendSummary';
import { TrendTable } from './TrendTable';

/** Скелетон-оси первой загрузки (§10, role=status; прецедент HistorySkeleton). */
function DashboardSkeleton(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div data-testid="dashboard-skeleton" role="status" aria-label={t('common.loading')}>
      <div aria-hidden="true" className="animate-pulse rounded-[10px] bg-surface p-4">
        <div className="mb-2 h-6 w-1/3 rounded bg-border" />
        <div className="flex h-72 items-end gap-2">
          <div className="h-full w-10 rounded bg-border" />
          <div className="h-full flex-1 rounded bg-border" />
        </div>
      </div>
    </div>
  );
}

/**
 * Число измерений в периоде из ответа trend/series (§13): raw — points.length,
 * daily — Σdays.count (точек в daily нет, но пустота определяется в обоих
 * режимах — тест-прецедент TrendTable: points.length===0 && days.length===0).
 */
function measurementCountOf(response: TrendResponse): number {
  if (response.mode === 'daily') {
    return (response.days ?? []).reduce((sum, day) => sum + day.count, 0);
  }
  return response.points?.length ?? 0;
}

/** Вид графика «Динамика» (§5 058): давление или пульс. */
export type DashboardView = 'pressure' | 'pulse';

/** Представление данных (§5 059): график или таблица тех же данных. */
export type DashboardAs = 'chart' | 'table';

/**
 * Хук представления (§12 059): URL `?as=` — истина; мусор/отсутствие → дефолт
 * chart (§14: без ошибок, как useDashboardView). Применение переписывает URL
 * (replace), остальные параметры (период, вид) сохраняются; дефолт удаляет
 * параметр (адрес чистый — прецедент view=).
 */
function useDashboardAs(): readonly [DashboardAs, (as: DashboardAs) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const as: DashboardAs = searchParams.get('as') === 'table' ? 'table' : 'chart';
  const setAs = useCallback(
    (next: DashboardAs) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'table') {
            params.set('as', 'table');
          } else {
            params.delete('as');
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return [as, setAs] as const;
}

/**
 * Хук вида (§12 058): URL `?view=` — истина; мусор/отсутствие → дефолт pressure
 * (§14: без ошибок, как parsePeriodState). Применение переписывает URL (replace —
 * вид не засоряет историю навигации), остальные параметры (период) сохраняются.
 */
function useDashboardView(): readonly [DashboardView, (view: DashboardView) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const view: DashboardView = searchParams.get('view') === 'pulse' ? 'pulse' : 'pressure';
  const setView = useCallback(
    (next: DashboardView) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'pulse') {
            params.set('view', 'pulse');
          } else {
            params.delete('view');
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return [view, setView] as const;
}

/**
 * Сегмент-переключатель вида (§5/§10 058): кнопки с aria-pressed (§10: «role=
 * tablist ИЛИ кнопки aria-pressed» — выбран вариант кнопок: без wiring tabpanel,
 * состояние читаем скринридером). Стили активной/неактивной кнопки различимы и
 * вне цвета (aria-pressed — программно).
 */
function ViewSwitcher({
  view,
  onView,
}: {
  readonly view: DashboardView;
  readonly onView: (view: DashboardView) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const buttonClass = (active: boolean): string =>
    `min-h-11 rounded-md border px-4 text-base ${
      active ? 'border-accent bg-accent/10 font-medium' : 'border-border hover:bg-accent/10'
    }`;
  return (
    <div
      data-testid="dashboard-view"
      role="group"
      aria-label={t('dashboard.view.label')}
      className="mb-4 flex flex-wrap gap-2"
    >
      <button
        type="button"
        data-testid="dashboard-view-pressure"
        aria-pressed={view === 'pressure'}
        onClick={() => onView('pressure')}
        className={buttonClass(view === 'pressure')}
      >
        {t('dashboard.view.pressure')}
      </button>
      <button
        type="button"
        data-testid="dashboard-view-pulse"
        aria-pressed={view === 'pulse'}
        onClick={() => onView('pulse')}
        className={buttonClass(view === 'pulse')}
      >
        {t('dashboard.view.pulse')}
      </button>
    </div>
  );
}

/**
 * Сегмент «График/Таблица» (§5 059): кнопки с aria-pressed (§16 059: «aria-pressed/
 * tablist» — выбран вариант кнопок, прецедент ViewSwitcher 058). Шаро-пригодно:
 * состояние в URL (§4 059 «?view=…&as=table»).
 */
function AsSwitcher({
  as,
  onAs,
}: {
  readonly as: DashboardAs;
  readonly onAs: (as: DashboardAs) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const buttonClass = (active: boolean): string =>
    `min-h-11 rounded-md border px-4 text-base ${
      active ? 'border-accent bg-accent/10 font-medium' : 'border-border hover:bg-accent/10'
    }`;
  return (
    <div
      data-testid="dashboard-as"
      role="group"
      aria-label={t('dashboard.view.as.label')}
      className="mb-4 flex flex-wrap gap-2"
    >
      <button
        type="button"
        data-testid="dashboard-as-chart"
        aria-pressed={as === 'chart'}
        onClick={() => onAs('chart')}
        className={buttonClass(as === 'chart')}
      >
        {t('dashboard.view.as.chart')}
      </button>
      <button
        type="button"
        data-testid="dashboard-as-table"
        aria-pressed={as === 'table'}
        onClick={() => onAs('table')}
        className={buttonClass(as === 'table')}
      >
        {t('dashboard.view.as.table')}
      </button>
    </div>
  );
}

/** Экран «Динамика» (§2): период-контрол + график тренда. */
export function DashboardScreen(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const period = useDashboardPeriod();
  const [view, setView] = useDashboardView();
  const [as, setAs] = useDashboardAs();
  const trend = useTrend(PROFILE_ID, period.param);
  const scale = useActiveScale();
  // TASK-059 §5: stats того же периода — единый источник чисел резюме и aria-
  // метки графика (§13: одни read models; переиспользование, не пересчёт).
  const stats = useStats(PROFILE_ID, period.param);

  // Live-обновление (§10/§12): событие точечно инвалидирует серии И статистику
  // профиля (частичный ключ — все периоды; прецедент ['measurements'] списка).
  useHlEvent('measurement:changed', (payload) => {
    void queryClient.invalidateQueries({
      queryKey: [...TREND_KEY_ROOT, payload.profileId],
    });
    void queryClient.invalidateQueries({
      queryKey: [...STATS_KEY_ROOT, payload.profileId],
    });
  });

  // Ошибка чтения (§10): тост по dto (IpcApiError → dto отказа, иное → INTERNAL).
  useEffect(() => {
    if (trend.isError && trend.error instanceof IpcApiError) {
      showToast(trend.error.dto);
    } else if (trend.isError) {
      showToast(APP_INTERNAL_ERROR);
    }
  }, [trend.isError, trend.error, showToast]);

  // Ошибка шкалы (§11): шкала — часть экрана; STORAGE/CORRUPT повреждённой шкалы
  // показывается тостом, график без опорных линий остаётся (§5: справка).
  useEffect(() => {
    if (scale.isError && scale.error instanceof IpcApiError) {
      showToast(scale.error.dto);
    } else if (scale.isError) {
      showToast(APP_INTERNAL_ERROR);
    }
  }, [scale.isError, scale.error, showToast]);

  // Ошибка stats (§10): резюме/метка — часть экрана; отказ — тост, график и
  // таблица из trend/series остаются (те же данные, §13).
  useEffect(() => {
    if (stats.isError && stats.error instanceof IpcApiError) {
      showToast(stats.error.dto);
    } else if (stats.isError) {
      showToast(APP_INTERNAL_ERROR);
    }
  }, [stats.isError, stats.error, showToast]);

  /**
   * §12: переход к правке — полный DTO записи (startEdit TASK-038 требует
   * arm/note/source-поля, которых у trend-точки нет) через measurements/list
   * с границами момента записи; записи нет (удалена между рендером и кликом) —
   * перехода нет, refetch уберёт точку с графика. Отказ — тост (§10).
   */
  const openEdit = useCallback(
    async (point: RawPoint) => {
      if (point.id === undefined) {
        return;
      }
      try {
        const result = await call('measurements/list', {
          profileId: PROFILE_ID,
          // Страница по умолчанию: записей в момент utc обычно 1–2 (дубликаты
          // отсеиваются политикой 032); offset 0 — выборка с начала.
          limit: HISTORY_PAGE_LIMIT,
          offset: 0,
          fromUtcMs: point.utcMs,
          toUtcMs: point.utcMs,
        });
        if (!result.ok) {
          showToast(result.error);
          return;
        }
        const dto = result.data.items.find((item) => item.id === point.id);
        if (dto === undefined) {
          return;
        }
        useFormStore.getState().startEdit(dto);
        void navigate('/journal');
      } catch {
        showToast(APP_INTERNAL_ERROR);
      }
    },
    [navigate, showToast],
  );

  const pending = trend.isPending || scale.isPending;
  // TASK-060 §13: пустой период — N=0 в обоих режимах (raw: точки; daily: Σcount).
  const isEmpty =
    !trend.isError && trend.data !== undefined && measurementCountOf(trend.data) === 0;
  // §5/§13: пометка «мало данных» (1≤N<AI_MIN_MEASUREMENTS) — ГОТОВЫЙ флаг порога
  // kernel из stats (N<7 считает main: единый источник с ИИ-честностью, TASK-006;
  // рендерер kernel не импортирует — арх. 03 §4). Число в пометке — count ТОГО ЖЕ
  // stats-ответа, что и флаг (не расходятся). Пустота приоритетнее пометки; отказ
  // stats — без пометки, график из trend остаётся (§10).
  const fewDataCount =
    !isEmpty && !stats.isError && stats.data?.stats.insufficientData.tooFewMeasurements === true
      ? stats.data.stats.count
      : undefined;

  /** Подпись периода для aria-резюме графика (те же подписи, что у сегмента). */
  const periodLabel = t(
    period.state.period === '7d'
      ? 'measurement.filters.period.7d'
      : period.state.period === '90d'
        ? 'measurement.filters.period.90d'
        : period.state.period === 'all'
          ? 'measurement.filters.period.all'
          : period.state.period === 'custom'
            ? 'measurement.filters.period.custom'
            : 'measurement.filters.period.30d',
  );

  /**
   * §5/§13 059: aria-метка графика ИЗ stats-резюме («те же числа» — резюме и
   * метка строятся из одного stats/period-ответа; тест-сверка DOM-чисел).
   * Канал без полных агрегатов (пустой период) — undefined: график считает метку
   * по загруженным точкам (локальный fallback, прецедент 057).
   */
  let statsAriaLabel: string | undefined;
  const statsDto = stats.data?.stats;
  if (
    statsDto !== undefined &&
    statsDto.sys.avg !== undefined &&
    statsDto.sys.min !== undefined &&
    statsDto.sys.max !== undefined &&
    statsDto.dia.avg !== undefined &&
    statsDto.dia.min !== undefined &&
    statsDto.dia.max !== undefined
  ) {
    statsAriaLabel = t('dashboard.a11y.chartLabel', {
      period: periodLabel,
      sysAvg: formatNumberRu(statsDto.sys.avg),
      sysMin: formatNumberRu(statsDto.sys.min),
      sysMax: formatNumberRu(statsDto.sys.max),
      diaAvg: formatNumberRu(statsDto.dia.avg),
      diaMin: formatNumberRu(statsDto.dia.min),
      diaMax: formatNumberRu(statsDto.dia.max),
      count: statsDto.count,
    });
  }

  return (
    <section className="p-4">
      <header className="mb-4">
        <h2 className="hl-large-title">{t('common.nav.dashboard')}</h2>
      </header>

      {/* §12 059: URL `?as=` — истина; представление «График/Таблица» — один фокус. */}
      <AsSwitcher as={as} onAs={setAs} />

      {/* §12 058: вид «Давление/Пульс» — только у графика: таблица строится из тех
          же данных и от вида не зависит, сегмент без эффекта скрыт; возврат к
          графику восстанавливает вид из URL (?view=). */}
      {as === 'chart' && <ViewSwitcher view={view} onView={setView} />}

      {/* §12: URL `?period=` — истина; сегмент и поля custom переиспользуют 044/046. */}
      <PeriodSwitcher state={period.state} onPeriod={period.setPeriod} onRange={period.setRange} />

      {pending ? (
        <DashboardSkeleton />
      ) : trend.isError ? (
        <section className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <h2 className="hl-large-title">{t('common.nav.dashboard')}</h2>
          <button
            type="button"
            data-testid="dashboard-retry"
            onClick={() => void trend.refetch()}
            className="rounded-xl bg-fill px-4 py-2 text-sm hover:bg-accent/10"
          >
            {t('dashboard.error.retry')}
          </button>
        </section>
      ) : isEmpty ? (
        // TASK-060 §5/§20 AC1: обучающая заглушка пустого периода; «Показать всё
        // время» — пока период ещё не all (на all пусто = записей нет вовсе,
        // действие-нооп не предлагается — честность §13).
        <EmptyChartState
          showAllTime={period.state.period !== 'all'}
          onAdd={() => {
            void navigate('/journal');
          }}
          onShowAll={() => period.setPeriod('all')}
        />
      ) : trend.data !== undefined ? (
        // §5 059: один ответ trend/series — график и таблица; таблица монтируется
        // лениво (§15: только в режиме table). Шкала нужна только давлению
        // (коридор пульса — константы контракта, §5 058).
        as === 'table' ? (
          <TrendTable response={trend.data} periodLabel={periodLabel} />
        ) : (
          <>
            {/* TASK-060 §5/§13: мало данных (1≤N<7, флаг stats=kernel) — полоса
                НАД графиком; сам график рендерится (не «пустое полотно», AC-3.6). */}
            {fewDataCount !== undefined && <FewDataNote count={fewDataCount} />}
            {view === 'pulse' ? (
              <PulseChart
                response={trend.data}
                periodLabel={periodLabel}
                onEditPoint={(point) => void openEdit(point)}
              />
            ) : (
              <TrendChart
                response={trend.data}
                scale={scale.data}
                periodLabel={periodLabel}
                ariaLabel={statsAriaLabel}
                onEditPoint={(point) => void openEdit(point)}
              />
            )}
            {/* §2/§5 059: резюме тренда под графиком — из stats (те же числа, что
                у aria-метки графика; §13 тест-сверка). */}
            {statsDto !== undefined && <TrendSummary stats={statsDto} periodLabel={periodLabel} />}
          </>
        )
      ) : null}
    </section>
  );
}
