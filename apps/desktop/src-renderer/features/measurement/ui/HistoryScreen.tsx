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
 *
 * TASK-038 §5/§12/§13/§16: правка/удаление записей. Меню строки (RowMenu через
 * DayGroup): «Изменить» → startEdit(dto) + вид form (режим edit управляется
 * editingId в form-store, не URL); «Удалить» → DeleteConfirmDialog (барьер
 * FR-2.3) → measurements/delete → invalidate (мутация) + тост «Удалено».
 * NOT_FOUND при delete/update — тост «Запись уже удалена» (§13). Фокус-возврат
 * в строку после действий (§16/§20 AC5): data-row-menu якоря + effect.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

import { APP_INTERNAL_ERROR } from '@hl/contracts';
import type { MeasurementDto } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import { useHlEvent } from '../../../lib/events';
import { IpcApiError, PROFILE_ID } from '../api/use-add-measurement';
import { measurementsKey, useMeasurements } from '../api/use-measurements';
import { useDeleteMeasurement } from '../api/use-delete-measurement';
import { useFormStore } from '../model/form-store';
import { groupByDay } from '../model/wall-date';
import { DayGroup } from './DayGroup';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { EmptyHistory } from './EmptyHistory';
import { MeasurementForm } from './MeasurementForm';

/** Вид вкладки журнала: список истории или форма ввода (§5). */
type View = 'list' | 'form';

/** Вид заметки после действий (§5: тост «Удалено»/«Правка применена»). */
type Notice = 'deleted' | 'edited';

/** Авто-скрытие заметки, мс (прецедент SAVED_TOAST_MS TASK-031). */
const NOTICE_MS = 4000;

/** Ключи заметок — литералы в карте (§22: динамических ключей нет, прецедент ARM_KEY). */
const NOTICE_KEY: Readonly<
  Record<Notice, 'measurement.toast.deleted' | 'measurement.toast.edited'>
> = {
  deleted: 'measurement.toast.deleted',
  edited: 'measurement.toast.edited',
};

/** Экранирование id для селектора-атрибута (CSS.escape отсутствует в jsdom). */
function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

/**
 * Фокус-возврат в строку списка (§16/§20 AC5): кнопка меню строки с data-row-menu
 * = id; строки нет (удалена) — ближайшая оставшаяся (§13: группа дня исчезает —
 * список перерисован, фокус в первой строке). excludeId — id только что удалённой
 * записи: refetch может прийти позже фокуса, и старую строку в DOM надо пропустить.
 */
function focusRowMenu(id: string | null, excludeId?: string | null): void {
  const specific =
    id === null
      ? null
      : document.querySelector<HTMLButtonElement>(`[data-row-menu="${escapeSelector(id)}"]`);
  if (specific !== null) {
    specific.focus();
    return;
  }
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-row-menu]');
  for (const button of buttons) {
    if (button.getAttribute('data-row-menu') !== excludeId) {
      button.focus();
      return;
    }
  }
}

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

/** Экран «Журнал»: история по дням + форма ввода (§2); с TASK-038 — правка/удаление. */
export function HistoryScreen(): JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('list');
  /** TASK-038 §5: запись в диалоге удаления (null — диалог закрыт). */
  const [deleteTarget, setDeleteTarget] = useState<MeasurementDto | null>(null);
  /** TASK-038: id правимой записи — для фокус-возврата при отмене формы. */
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  /** TASK-038 §16/§20 AC5: отложенный фокус-возврат в строку после действия. */
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  /** TASK-038 §5: заметка после действия («Удалено»/«Правка применена»). */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** id удаляемой записи — excludeId фокуса (refetch может прийти позже фокуса). */
  const deletedIdRef = useRef<string | null>(null);
  const measurements = useMeasurements(PROFILE_ID);

  // TASK-038 §16/§20 AC5: фокус-возврат — после смены вида на список, когда
  // строки снова в DOM; запись удалена → ближайшая оставшаяся (focusRowMenu).
  useEffect(() => {
    if (returnFocusId === null) {
      return;
    }
    focusRowMenu(returnFocusId);
    setReturnFocusId(null);
  }, [returnFocusId]);

  // Заметка скрывается сама (§5 — прецедент saved-тоста формы).
  useEffect(() => {
    if (notice === null) {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

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

  /**
   * TASK-038 §5/§12: меню строки — единственный стабильный колбэк (memo §15).
   * «Изменить» → startEdit(dto) + вид form; «Удалить» → диалог подтверждения.
   */
  const handleRowAction = useCallback((measurement: MeasurementDto, action: 'edit' | 'delete') => {
    if (action === 'edit') {
      setEditTargetId(measurement.id);
      useFormStore.getState().startEdit(measurement);
      setView('form');
      return;
    }
    setDeleteTarget(measurement);
  }, []);

  /** TASK-038 §5: подтверждение удаления → measurements/delete (§12: invalidate в мутации). */
  const deleteMutation = useDeleteMeasurement({
    onSuccess: () => {
      setNotice('deleted');
      // Фокус-возврат (§16/§20 AC5) — ПОСЛЕ обновления списка: ожидаем refetch
      // инвалидации; удаляемый id исключается (строка может быть ещё в DOM).
      void queryClient.invalidateQueries({ queryKey: measurementsKey(PROFILE_ID) }).then(() => {
        focusRowMenu(deleteTarget?.id ?? null, deletedIdRef.current);
      });
    },
    // §13: NOT_FOUND — «запись уже удалена» (другой путь), иное — тост отказа (§10).
    onError: (error) => {
      showToast(error);
    },
  });

  if (view === 'form') {
    return (
      <MeasurementForm
        onSuccess={() => setView('list')}
        onEditSuccess={(id) => {
          // §5: правка применена — тост + возврат к списку + фокус в строку (AC1/AC5).
          setNotice('edited');
          setView('list');
          setReturnFocusId(id);
        }}
        onCancel={() => {
          // §5: отмена (Esc/«Отмена», NOT_FOUND) — возврат к списку; правка не применена.
          setView('list');
          setReturnFocusId(editTargetId);
          setEditTargetId(null);
        }}
      />
    );
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
        <DayGroup key={group.key} group={group} nowMs={nowMs} onRowAction={handleRowAction} />
      ))}

      {/* TASK-038 §5: заметка после действий (role=status — polite, §16). */}
      {notice !== null && (
        <div data-testid="history-notice" role="status" className="mt-2 text-sm font-semibold">
          {t(NOTICE_KEY[notice])}
        </div>
      )}

      {/* TASK-038 §5: барьер удаления (FR-2.3) — подтверждение с «необратимо». */}
      <DeleteConfirmDialog
        target={deleteTarget}
        onConfirm={() => {
          if (deleteTarget === null || deleteMutation.isPending) {
            return;
          }
          deletedIdRef.current = deleteTarget.id;
          deleteMutation.mutate({ id: deleteTarget.id });
        }}
        onClose={() => {
          // Закрытие без удаления (Esc/«Отмена», §20 AC3: запись на месте) —
          // фокус в строку; после подтверждения фокус вернёт onSuccess.
          if (!deleteMutation.isPending) {
            focusRowMenu(deleteTarget?.id ?? null);
          }
          setDeleteTarget(null);
        }}
      />

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
