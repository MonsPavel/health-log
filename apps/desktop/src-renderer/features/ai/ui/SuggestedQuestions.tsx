/**
 * TASK-090 §5/§13: чипы-подсказки empty-state — три кликабельных примера
 * вопроса (§5 дословно). Клик — onPick с текстом чипа: ChatScreen ВСТАВЛЯЕТ
 * его в поле ввода и НЕ отправляет (решение §5 — пользователь правит вопрос
 * перед отправкой). Ключи i18n — статические литералы в карте (§22: динамика
 * запрещена — check-i18n не видит), прецедент PERIOD_KEY InsightScreen.
 */
import { useTranslation } from 'react-i18next';

/** Props чипов (§5): вставка текста в поле ввода — колбэк onPick. */
export interface SuggestedQuestionsProps {
  /** Клик по чипу: текст вопроса — в поле ввода (не отправка, §5). */
  readonly onPick: (question: string) => void;
}

/** Карта ключей чипов (§17 chat.chips.*): литералы для check-i18n (§22). */
const CHIP_KEY: Readonly<
  Record<
    'pressure' | 'morningEvening' | 'unusual',
    'ai.chat.chips.pressure' | 'ai.chat.chips.morningEvening' | 'ai.chat.chips.unusual'
  >
> = {
  pressure: 'ai.chat.chips.pressure',
  morningEvening: 'ai.chat.chips.morningEvening',
  unusual: 'ai.chat.chips.unusual',
};

/** Порядок чипов — как в §5. */
const CHIP_IDS = ['pressure', 'morningEvening', 'unusual'] as const;

/** Чипы-подсказки empty-state (§5): три примера вопроса. */
export function SuggestedQuestions({ onPick }: SuggestedQuestionsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div data-testid="chat-chips" className="flex flex-wrap gap-2">
      {CHIP_IDS.map((id) => (
        <button
          key={id}
          type="button"
          data-testid="chat-chip"
          onClick={() => onPick(t(CHIP_KEY[id]))}
          className="min-h-11 rounded-md border border-border bg-bg px-3 text-sm text-text hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {t(CHIP_KEY[id])}
        </button>
      ))}
    </div>
  );
}
