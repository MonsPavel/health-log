/**
 * TASK-033 §2/§5/§10/§12: экран «Журнал» — вертикальный срез ввода и списка.
 *
 * Список: useMeasurements (§12: ключ ['measurements', profileId, {limit:200,
 * …фильтры}], offset-пагинация «Показать ещё») → группировка по настенным дням
 * (model/wall-date: desc-порядок main сохраняется, заголовки «Сегодня/Вчера»/
 * Intl-дата) → DayGroup → MeasurementRow. Состояния (§10): pending — скелетон
 * 3 строки; empty — EmptyHistory (CTA → форма); error — тост + «Повторить»
 * (refetch); данные — список + подпись «Показано N из M» (total — TASK-030 §7)
 * + «Показать ещё» при hasNextPage.
 *
 * TASK-044 §2/§5/§10/§12/§16: панель фильтров над списком (HistoryFilters +
 * хук useMeasurementFilters — URL источник истины, §12); query-фрагмент уходит
 * в useMeasurements (ключ кэша включает фильтры — разные фильтры не конфликтуют;
 * keepPreviousData: при смене фильтра предыдущий список показывается до прихода
 * нового, панель не размонтируется — фокус остаётся на контроле, §16).
 * Пустой результат при АКТИВНЫХ фильтрах — особое состояние «сбросьте фильтры»
 * (§10), не обучающее EmptyHistory.
 *
 * Live (§5): useHlEvent('measurement:changed') → инвалидация ключа списка —
 * список обновляется после ввода (мутации TASK-031/032 инвалидируют ['measurements']
 * и дублируют событием — двойная защита, арх. 06 §3). Частичный ключ
 * ['measurements', profileId] матчит все варианты фильтров.
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
 *
 * TASK-045 §5/§10/§12/§13/§16/§17: поиск по заметкам. Непустой ?q= — режим поиска:
 * данные из notes/search (по всей БД), фильтры периода/руки/заметок сужают результат
 * на клиенте (matchesDtoFilters — §10); список-канал при этом отключён (enabled:
 * false — данные не смешиваются). Подписи режима поиска: «Найдено N» aria-live
 * (§16, плюрализация §17), «показаны первые 50» при равенстве лимиту (§13),
 * пустой результат — search.empty (§10). Событие measurement:changed инвалидирует
 * и поисковую ветку кэша ['measurements','search'] (§12).
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
import { SEARCH_KEY_ROOT, SEARCH_PAGE_LIMIT, useNotesSearch } from '../api/use-notes-search';
import { useDeleteMeasurement } from '../api/use-delete-measurement';
import { useFormStore } from '../model/form-store';
import { groupByDay } from '../model/wall-date';
import { matchesDtoFilters } from '../model/filters';
import { DayGroup } from './DayGroup';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { EmptyHistory } from './EmptyHistory';
import { FlagLegend } from './FlagBadges';
import { HistoryFilters, useMeasurementFilters } from './HistoryFilters';
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

/**
 * TASK-045 §17: «Найдено N» — плюрализация. i18next-каталог хранит формы суффиксами
 * LDML (_one/_few/_many/_other), выбор — Intl.PluralRules('ru') в карте с ПОЛНЫМИ
 * литералами ключей (§22: check-i18n видит каждый ключ; переменная категории в
 * ключ не подставляется). Подстановка {{n}} — интерполяция, не plural-механика
 * i18next (иначе ключ с суффиксом ре-резолвится повторно).
 */
type SearchFoundKey =
  | 'measurement.search.foundN_one'
  | 'measurement.search.foundN_few'
  | 'measurement.search.foundN_many'
  | 'measurement.search.foundN_other';

/** Категория plural → полный литерал ключа каталога (§22). */
const FOUND_KEY: Readonly<Record<'one' | 'few' | 'many' | 'other', SearchFoundKey>> = {
  one: 'measurement.search.foundN_one',
  few: 'measurement.search.foundN_few',
  many: 'measurement.search.foundN_many',
  other: 'measurement.search.foundN_other',
};

/** Ключ «Найдено N» по числу (§17): Intl.PluralRules('ru') + карта литералов. */
function foundKeyFor(count: number): SearchFoundKey {
  switch (new Intl.PluralRules('ru').select(count)) {
    case 'one':
      return FOUND_KEY.one;
    case 'few':
      return FOUND_KEY.few;
    case 'many':
      return FOUND_KEY.many;
    default:
      return FOUND_KEY.other;
  }
}

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
          className="mb-2 h-6 animate-pulse rounded bg-border"
        />
      ))}
    </div>
  );
}

/**
 * Пустой результат при активных фильтрах (§10): сообщение «сбросьте фильтры»
 * + кнопка сброса — не путать с обучающим EmptyHistory («вообще нет данных»).
 */
function EmptyFiltered({ onReset }: { readonly onReset: () => void }): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="empty-filtered"
      className="flex flex-col items-center gap-2 px-6 py-16 text-center"
    >
      <span aria-hidden="true" className="text-5xl" role="presentation">
        🔍
      </span>
      <p className="text-base font-medium">{t('measurement.history.empty.filtered')}</p>
      <button
        type="button"
        data-testid="empty-filtered-reset"
        onClick={onReset}
        className="mt-4 rounded-md border border-border px-4 py-2 text-sm hover:bg-accent/10"
      >
        {t('measurement.filters.reset')}
      </button>
    </div>
  );
}

/**
 * Пустой результат поиска (TASK-045 §10/§17): «измените запрос» — отдельное
 * состояние, не путать с EmptyHistory («вообще нет данных») и EmptyFiltered
 * («фльтры без результата»). Причина пустоты видна в поисковой строке — кнопка
 * сброса не нужна.
 */
function EmptySearch(): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="empty-search"
      className="flex flex-col items-center gap-2 px-6 py-16 text-center"
    >
      <span aria-hidden="true" className="text-5xl" role="presentation">
        🔍
      </span>
      <p className="text-base font-medium">{t('measurement.search.empty')}</p>
    </div>
  );
}

/** Экран «Журнал»: история по дням + форма ввода (§2); с TASK-038 — правка/удаление. */
export function HistoryScreen(): JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  // TASK-057 §12 (сквозной переход к правке с графика динамики): режим edit
  // управляется store-полем editingId (не URL, TASK-038) — если правка уже
  // открыта (DashboardScreen: startEdit + navigate('/journal')), вид начинается
  // с формы; сохранение/отмена снимают editingId (MeasurementForm) → список.
  const [view, setView] = useState<View>(() =>
    useFormStore.getState().editingId !== null ? 'form' : 'list',
  );
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
  // TASK-044 §5/§12: фильтры — из URL (хук), query-фрагмент — в ключе кэша списка.
  // TASK-045 §10/§12: непустой ?q= — режим поиска: данные из notes/search (вся БД),
  // фильтры сужают результат на клиенте; список-канал в этом режиме отключён.
  const filters = useMeasurementFilters();
  const searchQuery = filters.state.q ?? '';
  const isSearching = searchQuery !== '';
  const measurements = useMeasurements(PROFILE_ID, filters.query, { enabled: !isSearching });
  const search = useNotesSearch(searchQuery);

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

  // Live-обновление (§5/§12): событие точечно инвалидирует ключ списка профиля и
  // поисковую ветку кэша (TASK-045 §12: ['measurements','search']).
  useHlEvent('measurement:changed', (payload) => {
    void queryClient.invalidateQueries({ queryKey: measurementsKey(payload.profileId) });
    void queryClient.invalidateQueries({ queryKey: [...SEARCH_KEY_ROOT] });
  });

  // Ошибка чтения (§10): тост по dto (IpcApiError → dto отказа, иное → INTERNAL);
  // текст дублирует панель ошибки, повтор — кнопкой ниже. Режим поиска — ошибка search.
  useEffect(() => {
    const error = isSearching ? search.error : measurements.error;
    const isError = isSearching ? search.isError : measurements.isError;
    if (!isError) {
      return;
    }
    showToast(error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR);
  }, [
    isSearching,
    search.isError,
    search.error,
    measurements.isError,
    measurements.error,
    showToast,
  ]);

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

  // TASK-045 §10: pending/ошибка — по активному источнику данных (поиск или список).
  const isPending = isSearching ? search.isPending : measurements.isPending;
  if (isPending) {
    return <HistorySkeleton />;
  }

  if (isSearching ? search.isError : measurements.isError) {
    return (
      <section className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        {/* TASK-108 §5 (page-has-heading-one): заголовок экрана — h1 (и в ошибке). */}
        <h1 className="text-lg font-semibold">{t('common.nav.journal')}</h1>
        <button
          type="button"
          onClick={() => void (isSearching ? search.refetch() : measurements.refetch())}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent/10"
        >
          {t('measurement.history.retry')}
        </button>
      </section>
    );
  }

  // Данные (§10): поиск — ответ notes/search, суженный фильтрами на клиенте
  // (matchesDtoFilters); список — страницы useInfiniteQuery. В режиме поиска
  // список-запрос отключён (enabled:false) — его data undefined, не читаем.
  const items = isSearching
    ? (search.data?.items ?? []).filter((dto) => matchesDtoFilters(filters.query, dto))
    : (measurements.data?.pages.flatMap((page) => page.items) ?? []);
  // «Сейчас» — один на рендер: заголовки дней стабильны внутри прохода (§13).
  const nowMs = Date.now();
  const total = measurements.data?.pages[0]?.total ?? 0;
  // TASK-042 §5: легенда флагов — только при наличии хоть одного флага в списке.
  const hasFlags = items.some((m) => m.critical !== undefined || m.irregularPulse);

  return (
    <section className="p-4">
      <header className="mb-4 flex items-center justify-between">
        {/* TASK-108 §5 (page-has-heading-one): заголовок экрана — h1; группы дней —
            h2 (DayGroup) — без пропуска уровней. */}
        <h1 className="text-lg font-semibold">{t('common.nav.journal')}</h1>
        <button
          type="button"
          onClick={() => setView('form')}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
        >
          {t('measurement.history.add')}
        </button>
      </header>

      {/* TASK-044 §5: панель фильтров — период/рука/заметки/сброс; URL — источник
          истины (§12). Панель не размонтируется при смене данных — фокус остаётся (§16).
          TASK-045 §5: строка поиска — в панели (debounce 300 мс, §10).
          TASK-046 §5: произвольный период — CustomRangeFields в панели, setRange
          применяет валидный диапазон в URL (invalid блокирует компонент, §19). */}
      <HistoryFilters
        state={filters.state}
        onPeriod={filters.setPeriod}
        onArm={filters.setArm}
        onNoted={filters.setNoted}
        onQuery={filters.setQuery}
        onRange={filters.setRange}
        onReset={filters.reset}
      />

      {/* TASK-045 §16/§17: «Найдено N» — aria-live строка режима поиска. */}
      {isSearching && items.length > 0 && (
        <p
          data-testid="search-found"
          role="status"
          aria-live="polite"
          className="mb-2 text-sm text-muted"
        >
          {t(foundKeyFor(items.length), { n: items.length })}
        </p>
      )}

      {/* TASK-045 §13: результат равен лимиту страницы — предупреждение об усечении. */}
      {isSearching && items.length === SEARCH_PAGE_LIMIT && (
        <p data-testid="search-truncated" className="mb-2 text-xs text-muted">
          {t('measurement.search.truncated50', { n: SEARCH_PAGE_LIMIT })}
        </p>
      )}

      {/* TASK-042 §5: легенда флагов над списком — обучающая строка при наличии флагов. */}
      {hasFlags && <FlagLegend />}

      {items.length === 0 ? (
        // §10: в режиме поиска пустой результат — «измените запрос» (§17 search.empty).
        isSearching ? (
          <EmptySearch />
        ) : // §10: пусто при активных фильтрах — «сбросьте фильтры», не «нет данных».
        filters.isActive ? (
          <EmptyFiltered onReset={filters.reset} />
        ) : (
          <EmptyHistory onAdd={() => setView('form')} />
        )
      ) : (
        groupByDay(items).map((group) => (
          <DayGroup key={group.key} group={group} nowMs={nowMs} onRowAction={handleRowAction} />
        ))
      )}

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

      {/* TASK-038 §5: подпись и «Показать ещё» — только режим списка (поиск: foundN,
          усечение §13; total/пагинации у notes/search нет, §11). */}
      {items.length > 0 && !isSearching && (
        <>
          <p data-testid="history-shown" className="mt-2 text-xs text-muted">
            {t('measurement.history.shownOf', { shown: items.length, total })}
          </p>
          {measurements.hasNextPage ? (
            <button
              type="button"
              onClick={() => void measurements.fetchNextPage()}
              className="mt-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-accent/10"
            >
              {t('measurement.history.showMore')}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
