/**
 * TASK-060 §2/§5/§16/§17: обучающая заглушка пустого периода экрана «Динамика»
 * (AC-3.6, FR-9.2): пустота без подсказки = впечатление «сломано» — заглушка
 * превращает пустоту в следующий шаг (прецедент EmptyHistory TASK-033): иконка
 * (декоративная, aria-hidden), текст «За выбранный период измерений нет» (§5),
 * CTA «Добавить измерение» → журнал (§20 AC1: форма доступна кнопкой «Добавить»
 * журнала — HistoryScreen вне §6 задачи) и действие «Показать всё время» →
 * период all.
 *
 * УПРОЩЕНИЕ §5: о записях вне периода без второго запроса не спрашиваем — оба
 * действия показываются всегда, ПОКА период ещё не all. На all пусто = записей
 * нет вовсе: «Показать всё время» было бы действием-нооп — скрывается вместе с
 * подсказкой (честность §13/EC-09); подсказка сформулирована вопросом («Есть
 * записи раньше?»), а не утверждением — факт записей вне периода неизвестен.
 *
 * ДОСТУПНОСТЬ (§16): обе кнопки — обычные кнопки tab-порядка с различимым
 * текстом; контраст AA (accent-фон + белый текст — токены темы, прецедент
 * EmptyHistory).
 */
import { useTranslation } from 'react-i18next';

/** Свойства заглушки (§5): действия замыкает экран, видимость альтернативы — период. */
export interface EmptyChartStateProps {
  /** Клик CTA «Добавить измерение» → журнал/форма (§20 AC1). */
  readonly onAdd: () => void;
  /** Клик «Показать всё время» → период all (§5). */
  readonly onShowAll: () => void;
  /** Период ещё не all — альтернативу «Показать всё время» показываем (§5). */
  readonly showAllTime: boolean;
}

/** Обучающая заглушка пустого периода (§5): иконка + текст + CTA + «всё время». */
export function EmptyChartState({
  onAdd,
  onShowAll,
  showAllTime,
}: EmptyChartStateProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="empty-chart"
      className="flex flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <span aria-hidden="true" className="text-5xl" role="presentation">
        📈
      </span>
      <p data-testid="empty-chart-title" className="text-base font-medium">
        {t('dashboard.empty.title')}
      </p>
      {showAllTime && (
        <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
          {t('dashboard.empty.hint')}
        </p>
      )}
      <button
        type="button"
        data-testid="empty-chart-add"
        onClick={onAdd}
        className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
      >
        {t('dashboard.empty.add')}
      </button>
      {showAllTime && (
        <button
          type="button"
          data-testid="empty-chart-show-all"
          onClick={onShowAll}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {t('dashboard.empty.showAll')}
        </button>
      )}
    </div>
  );
}
