/**
 * TASK-061 §2/§4/§5/§6/§12/§15/§16: домашний экран-сводка (/dashboard) —
 * стартовый маршрут приложения: последнее измерение (крупно), средние за 7 дней
 * (СДА/ДДА/ЧСС + count, категория+notes), регулярность (серия дней дружелюбно)
 * и быстрый CTA «Добавить измерение»; под сводкой — график динамики TASK-057
 * (§6 УПРОЩЕНИЕ: переезда на /dashboard/trends НЕТ — один маршрут, секции;
 * якорь #trends). Всё — из СУЩЕСТВУЮЩИХ read models (§4: принцип задачи):
 *
 * Данные (§12) — три лёгких запроса параллельно (React Query, §15):
 *  - measurements/list {limit:1} — последняя запись (desc-порядок main) + total
 *    (честный признак пустой БД);
 *  - stats/period 7d — средние + classification (категория/notes, пороги
 *    insufficientData — готовые флаги kernel из main);
 *  - stats/period 30d — регулярность (longestStreakDays/daysWithMeasurements).
 *
 * Состояния (§5): pending — скелетон (role=status); пустая БД (total 0) —
 * приветственный экран «Начните дневник» с CTA (обучающий, FR-9.2) ВМЕСТО всего
 * содержимого: карточек нет и секция графика не монтируется (обе обучающие
 * заглушки стопкой — двойной шум; график появляется вместе с данными, его
 * собственная пустая заглушка TASK-060 обслуживает «пустой период при записях»);
 * ошибка чтения — тост + «Повторить» (прецедент графика). CTA → /journal:
 * форма не URL-адресуема (HistoryScreen TASK-033/038), открывается кнопкой
 * «Добавить» журнала — та же интерпретация AC1, что у EmptyChartState TASK-060.
 *
 * Live (§12): measurement:changed → инвалидация ['measurements', pid] (матчит
 * и 'last', и страницы журнала) + ['stats', pid] — сводка живая, без
 * перезагрузки (§24 ручная проверка).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { APP_INTERNAL_ERROR } from '@hl/contracts';
import type { AppErrorDto } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import { useHlEvent } from '../../../lib/events';
import { IpcApiError, PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { BackupDialog } from '../../reports/ui/data/BackupDialog';
import { useLastMeasurement } from '../api/use-last-measurement';
import { STATS_KEY_ROOT, useStats } from '../api/use-stats';
import { AverageCard } from './AverageCard';
import { BackupReminderBanner } from './BackupReminderBanner';
import { DashboardScreen } from './DashboardScreen';
import { LastMeasurementCard } from './LastMeasurementCard';
import { RegularityCard } from './RegularityCard';

/** Скелетон первой загрузки (§10, role=status; прецедент DashboardSkeleton). */
function SummarySkeleton(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div data-testid="summary-skeleton" role="status" aria-label={t('common.loading')}>
      <div aria-hidden="true" className="animate-pulse rounded-md border border-border p-4">
        <div className="mb-2 h-4 w-1/4 rounded bg-neutral-200 dark:bg-neutral-700" />
        <div className="h-10 w-1/3 rounded bg-neutral-200 dark:bg-neutral-700" />
      </div>
    </div>
  );
}

/** Тост об отказе канала (§10): IpcApiError → dto отказа, иное → INTERNAL. */
function useChannelErrorToast(
  isError: boolean,
  error: Error | null,
  showToast: (error: AppErrorDto) => void,
): void {
  useEffect(() => {
    if (isError) {
      showToast(error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR);
    }
  }, [isError, error, showToast]);
}

/** Приветственный экран пустого дневника (§5: обучающий, FR-9.2). */
function WelcomeState({ onAdd }: { readonly onAdd: () => void }): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="dashboard-welcome"
      className="flex flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <span aria-hidden="true" className="text-5xl" role="presentation">
        📝
      </span>
      <p data-testid="dashboard-welcome-title" className="text-lg font-semibold">
        {t('dashboard.welcome.title')}
      </p>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
        {t('dashboard.welcome.hint')}
      </p>
      <button
        type="button"
        data-testid="dashboard-welcome-add"
        onClick={onAdd}
        className="mt-2 min-h-12 rounded-md bg-accent px-6 text-base font-semibold text-white hover:opacity-90"
      >
        {t('dashboard.home.add')}
      </button>
    </div>
  );
}

/** Домашний экран-сводка (§2): карточки из готовых read models + график ниже. */
export function SummaryScreen(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // §12: три запроса параллельно (§15) — последний, средние 7д, регулярность 30д.
  // Подпись категории едет В stats-ответе (SCALE_CATEGORY.label из данных шкалы,
  // §4 054) — четвёртый запрос сводке не нужен.
  const last = useLastMeasurement(PROFILE_ID);
  const stats7d = useStats(PROFILE_ID, '7d');
  const stats30d = useStats(PROFILE_ID, '30d');

  // TASK-074 §12: баннер-подсказка о копии — локальный state от события
  // job:backup-reminder (решение о показе — scheduler main, дедупликация 1/7д);
  // «Создать копию» — диалог 073 (локально, §11).
  const [backupReminderVisible, setBackupReminderVisible] = useState(false);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  useHlEvent('job:backup-reminder', () => setBackupReminderVisible(true));

  // Live-обновление (§12): частичные ключи матчат 'last' и все периоды stats.
  useHlEvent('measurement:changed', (payload) => {
    void queryClient.invalidateQueries({ queryKey: ['measurements', payload.profileId] });
    void queryClient.invalidateQueries({
      queryKey: [...STATS_KEY_ROOT, payload.profileId],
    });
  });

  // Ошибки каналов (§10): тост по dto (IpcApiError → dto отказа, иное → INTERNAL).
  useChannelErrorToast(last.isError, last.error, showToast);
  useChannelErrorToast(stats7d.isError, stats7d.error, showToast);
  useChannelErrorToast(stats30d.isError, stats30d.error, showToast);

  const openAdd = useCallback(() => {
    void navigate('/journal');
  }, [navigate]);

  // TASK-074 §10: «Создать копию» — баннер скрыт, открывается диалог 073;
  // «Позже» — баннер скрыт (пауза недели уже записана scheduler'ом при показе).
  const openBackupDialog = useCallback(() => {
    setBackupReminderVisible(false);
    setBackupDialogOpen(true);
  }, []);
  const dismissBackupReminder = useCallback(() => {
    setBackupReminderVisible(false);
  }, []);

  // Пустая БД (§5/§20 AC1): total — ВСЕ записи профиля (TASK-030 §7); ноль →
  // приветственный экран вместо карточек и графика (см. шапку).
  const isEmpty = !last.isError && last.data !== undefined && last.data.total === 0;
  const lastMeasurement = last.data?.items[0];

  return (
    <section className="p-4">
      {/* TASK-074 §10: подсказка о копии — ненавязчивый баннер вверху дашборда. */}
      {backupReminderVisible && (
        <BackupReminderBanner onCreate={openBackupDialog} onLater={dismissBackupReminder} />
      )}

      <header className="mb-4">
        <h2 className="text-lg font-semibold">{t('dashboard.home.title')}</h2>
      </header>

      {last.isPending ? (
        <SummarySkeleton />
      ) : last.isError ? (
        <section className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-base text-neutral-500 dark:text-neutral-400">
            {t('common.nav.dashboard')}
          </p>
          <button
            type="button"
            data-testid="summary-retry"
            onClick={() => void last.refetch()}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            {t('dashboard.error.retry')}
          </button>
        </section>
      ) : isEmpty ? (
        <WelcomeState onAdd={openAdd} />
      ) : (
        <>
          {lastMeasurement !== undefined && (
            <div className="grid gap-4 md:grid-cols-2">
              <LastMeasurementCard
                measurement={lastMeasurement}
                nowMs={Date.now()}
                onAdd={openAdd}
              />
              {stats7d.data !== undefined && <AverageCard stats={stats7d.data.stats} />}
              {stats30d.data !== undefined && <RegularityCard stats={stats30d.data.stats} />}
            </div>
          )}

          {/* §6 УПРОЩЕНИЕ: график остаётся на том же маршруте секцией ниже (якорь #trends). */}
          <section id="trends" aria-label={t('dashboard.home.trendsAnchor')} className="mt-6">
            <DashboardScreen />
          </section>
        </>
      )}

      {/* TASK-074 §11: «Создать копию» баннера — тот же диалог 073 (локально). */}
      <BackupDialog open={backupDialogOpen} onClose={() => setBackupDialogOpen(false)} />
    </section>
  );
}
