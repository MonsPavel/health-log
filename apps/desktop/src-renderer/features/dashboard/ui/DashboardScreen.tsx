/**
 * TASK-057 §2/§5/§10/§11/§12: экран «Динамика» (/dashboard) — главный экран
 * понимания тренда (US-10): график СДА/ДДА с опорными линиями справочных
 * значений и подписью источника шкалы, точки различают утро/вечер формой+цветом,
 * переключатели периода 7д/30д/90д/всё/произвольный (URL `?period=` — истина,
 * §12), тултип с точными значениями и переходом к правке записи.
 *
 * Данные (§11): useTrend (trend/series — режим raw/daily решает read model 056)
 * и useActiveScale (scales/active — опорные линии ИЗ ДАННЫХ шкалы, не хардкод).
 * Период (§12): useDashboardPeriod (lib/period — те же URL-семантики, что у
 * журнала TASK-044/046; custom → utcMs-границы periodToStatsParam).
 *
 * Состояния (§10): loading — скелетон-оси; empty — каркас TASK-060 («Нет данных
 * за период» + CTA — «пустое место» для полноценного состояния 060); error —
 * тост + «Повторить» (прецедент HistoryScreen); данные — график + легенда
 * (+ мини-таблица клавиатуры в raw, §16). daily — подпись «агрегировано по дням»
 * (честность, §10) — внутри TrendChart.
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
import { useNavigate } from 'react-router-dom';

import { APP_INTERNAL_ERROR } from '@hl/contracts';
import type { RawPoint } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import { useHlEvent } from '../../../lib/events';
import { call } from '../../../src/lib/ipc';
import { IpcApiError, PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { HISTORY_PAGE_LIMIT } from '../../measurement/api/use-measurements';
import { useFormStore } from '../../measurement/model/form-store';
import { useActiveScale } from '../api/use-active-scale';
import { TREND_KEY_ROOT, useTrend } from '../api/use-trend';
import { useDashboardPeriod } from './PeriodSwitcher';
import { PeriodSwitcher } from './PeriodSwitcher';
import { TrendChart } from './TrendChart';

/** Скелетон-оси первой загрузки (§10, role=status; прецедент HistorySkeleton). */
function DashboardSkeleton(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div data-testid="dashboard-skeleton" role="status" aria-label={t('common.loading')}>
      <div aria-hidden="true" className="animate-pulse rounded-md border border-border p-4">
        <div className="mb-2 h-6 w-1/3 rounded bg-neutral-200 dark:bg-neutral-700" />
        <div className="flex h-72 items-end gap-2">
          <div className="h-full w-10 rounded bg-neutral-200 dark:bg-neutral-700" />
          <div className="h-full flex-1 rounded bg-neutral-100 dark:bg-neutral-800" />
        </div>
      </div>
    </div>
  );
}

/** Каркас пустого состояния (§10: TASK-060 доработает детали — место оставлено). */
function EmptyChart({ onOpenJournal }: { readonly onOpenJournal: () => void }): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="empty-chart"
      className="flex flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <p className="text-base font-medium">{t('dashboard.empty.title')}</p>
      <button
        type="button"
        data-testid="empty-chart-cta"
        onClick={onOpenJournal}
        className="rounded-md border border-border px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {t('dashboard.empty.cta')}
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
  const trend = useTrend(PROFILE_ID, period.param);
  const scale = useActiveScale();

  // Live-обновление (§10/§12): событие точечно инвалидирует серии профиля
  // (частичный ключ — все периоды; прецедент ['measurements'] списка).
  useHlEvent('measurement:changed', (payload) => {
    void queryClient.invalidateQueries({
      queryKey: [...TREND_KEY_ROOT, payload.profileId],
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
  const isEmpty =
    !trend.isError && trend.data?.mode === 'raw' && (trend.data.points?.length ?? 0) === 0;

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

  return (
    <section className="p-4">
      <header className="mb-4">
        <h2 className="text-lg font-semibold">{t('common.nav.dashboard')}</h2>
      </header>

      {/* §12: URL `?period=` — истина; сегмент и поля custom переиспользуют 044/046. */}
      <PeriodSwitcher state={period.state} onPeriod={period.setPeriod} onRange={period.setRange} />

      {pending ? (
        <DashboardSkeleton />
      ) : trend.isError ? (
        <section className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">{t('common.nav.dashboard')}</h2>
          <button
            type="button"
            data-testid="dashboard-retry"
            onClick={() => void trend.refetch()}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            {t('dashboard.error.retry')}
          </button>
        </section>
      ) : isEmpty ? (
        <EmptyChart
          onOpenJournal={() => {
            void navigate('/journal');
          }}
        />
      ) : trend.data !== undefined ? (
        <TrendChart
          response={trend.data}
          scale={scale.data}
          periodLabel={periodLabel}
          onEditPoint={(point) => void openEdit(point)}
        />
      ) : null}
    </section>
  );
}
