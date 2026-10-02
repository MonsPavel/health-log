/**
 * TASK-033 §2/§3/§5: обучающее пустое состояние истории (FR-9.2, AC-3.6-дух):
 * иллюстрация-иконка (декоративная, aria-hidden) + две строки текста (заголовок,
 * подсказка «Измерьте давление и нажмите „Добавить"») + CTA, открывающий форму
 * ввода (TASK-031) — пустота превращается в следующий шаг (§3).
 */
import { useTranslation } from 'react-i18next';

/** Props пустого состояния: CTA замыкает навигацию на форму (§5). */
export interface EmptyHistoryProps {
  /** Клик «Добавить» → форма (HistoryScreen переключает вид). */
  readonly onAdd: () => void;
}

/** Пустая история: иконка + заголовок + подсказка + CTA (§5). */
export function EmptyHistory({ onAdd }: EmptyHistoryProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="empty-history"
      className="flex flex-col items-center gap-2 px-6 py-16 text-center"
    >
      <span aria-hidden="true" className="text-5xl" role="presentation">
        🩺
      </span>
      <p className="text-base font-medium">{t('measurement.history.empty.title')}</p>
      <p className="max-w-sm text-sm text-neutral-500">{t('measurement.history.empty.hint')}</p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
      >
        {t('measurement.history.empty.cta')}
      </button>
    </div>
  );
}
