/**
 * TASK-033 §2/§5/§10/§12: экран «Журнал» — вертикальный срез ввода и списка.
 *
 * Список: useMeasurements (§12: ключ ['measurements', profileId, {limit:200}],
 * offset-пагинация «Показать ещё») → группировка по настенным дням (model/wall-date:
 * desc-порядок main сохраняется, заголовки «Сегодня/Вчера»/Intl-дата) → DayGroup →
 * MeasurementRow. Состояния (§10): pending — скелетон 3 строки; empty —
 * EmptyHistory (CTA → форма); error — тост + «Повторить» (refetch); данные —
 * список + подпись «Показано N из M» (total — TASK-030 §7) + «Показать ещё»
 * при hasNextPage.
 *
 * Live (§5): useHlEvent('measurement:changed') → инвалидация ключа списка —
 * список обновляется после ввода (мутации TASK-031/032 инвалидируют ['measurements']
 * и дублируют событием — двойная защита, арх. 06 §3).
 *
 * Форма (§5 «кнопка „Добавить" → форма»): вид-переключатель list|form — CTA пустого
 * состояния и кнопка «Добавить» открывают MeasurementForm (TASK-031); успешное
 * сохранение возвращает к списку (обновится по инвалидации/событию — AC §20).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

import { APP_INTERNAL_ERROR } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import { useHlEvent } from '../../../lib/events';
import { IpcApiError, PROFILE_ID } from '../api/use-add-measurement';
import { measurementsKey, useMeasurements } from '../api/use-measurements';
import { groupByDay } from '../model/wall-date';
import { DayGroup } from './DayGroup';
import { EmptyHistory } from './EmptyHistory';
import { MeasurementForm } from './MeasurementForm';

/** Вид вкладки журнала: список истории или форма ввода (§5). */
type View = 'list' | 'form';

/** Скелетон первой загрузки — 3 строки-заглушки (§10, role=status). */
function HistorySkeleton(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div data-testid="history-skeleton" role="status" aria-label={t('common.loading')}>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          data-testid="skeleton-row"
          aria-hidden="true"
          className="mb-2 h-6 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700"
        />
      ))}
    </div>
  );
}

/** Экран «Журнал»: история по дням + форма ввода (§2). */
export function HistoryScreen(): JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('list');
  const measurements = useMeasurements(PROFILE_ID);

  // Live-обновление (§5/§12): событие точечно инвалидирует ключ списка профиля.
  useHlEvent('measurement:changed', (payload) => {
    void queryClient.invalidateQueries({ queryKey: measurementsKey(payload.profileId) });
  });

  // Ошибка чтения (§10): тост по dto (IpcApiError → dto отказа, иное → INTERNAL);
  // текст дублирует панель ошибки, повтор — кнопкой ниже.
  useEffect(() => {
    if (!measurements.isError) {
      return;
    }
    const { error } = measurements;
    showToast(error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR);
  }, [measurements.isError, measurements.error, showToast]);

  if (view === 'form') {
    return <MeasurementForm onSuccess={() => setView('list')} />;
  }

  if (measurements.isPending) {
    return <HistorySkeleton />;
  }

  if (measurements.isError) {
    return (
      <section className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <h2 className="text-lg font-semibold">{t('common.nav.journal')}</h2>
        <button
          type="button"
          onClick={() => void measurements.refetch()}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {t('measurement.history.retry')}
        </button>
      </section>
    );
  }

  const items = measurements.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return <EmptyHistory onAdd={() => setView('form')} />;
  }

  // «Сейчас» — один на рендер: заголовки дней стабильны внутри прохода (§13).
  const nowMs = Date.now();
  const total = measurements.data.pages[0]?.total ?? 0;

  return (
    <section className="p-4">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('common.nav.journal')}</h2>
        <button
          type="button"
          onClick={() => setView('form')}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          {t('measurement.history.add')}
        </button>
      </header>

      {groupByDay(items).map((group) => (
        <DayGroup key={group.key} group={group} nowMs={nowMs} />
      ))}

      <p data-testid="history-shown" className="mt-2 text-xs text-neutral-500">
        {t('measurement.history.shownOf', { shown: items.length, total })}
      </p>
      {measurements.hasNextPage ? (
        <button
          type="button"
          onClick={() => void measurements.fetchNextPage()}
          className="mt-2 rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {t('measurement.history.showMore')}
        </button>
      ) : null}
    </section>
  );
}
