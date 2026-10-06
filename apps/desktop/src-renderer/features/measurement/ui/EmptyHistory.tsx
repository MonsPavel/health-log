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
      <span aria-hidden="true" role="presentation" className="relative mb-2 text-muted">
        <svg width="88" height="88" viewBox="0 0 88 88" fill="none">
          <rect
            x="22"
            y="14"
            width="44"
            height="60"
            rx="8"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <path
            d="M30 44h7l3-7 4 14 3-7h11"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M30 60h18M30 26h28"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle
            cx="63"
            cy="63"
            r="11"
            fill="var(--hl-bg)"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <path
            d="M63 57.5v11M57.5 63h11"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <p className="text-lg font-bold">{t('measurement.history.empty.title')}</p>
      <p className="max-w-sm text-sm text-muted">{t('measurement.history.empty.hint')}</p>
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
