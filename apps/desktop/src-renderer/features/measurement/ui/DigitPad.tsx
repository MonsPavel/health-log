/**
 * TASK-031 §5/§15/§16: цифровая клавиатура формы — 0–9, backspace, очистить.
 * Общая для трёх числовых полей: активное поле решает форма (пропсы-колбэки —
 * компонент презентационный, memoized §15: ре-рендер только при смене колбэков).
 *
 * a11y (§16, NFR-6): цели нажатия ≥44×44 — min-h-11/min-w-11 (2.75rem, rem
 * масштабируется с FR-8.2); aria-label цифр «Ввести N»; крупные цифры (text-2xl)
 * — персон П1/П3 (BG-1).
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Базовый класс кнопки клавиатуры: крупная цель ≥44px (§16). */
const KEY_CLASS =
  'min-h-11 min-w-11 rounded-md border border-border bg-bg px-3 text-2xl font-semibold text-text hover:bg-accent/10';

/** Props клавиатуры: колбэки без знания об активном поле (решает форма). */
export interface DigitPadProps {
  /** Нажата цифра (0–9). */
  readonly onDigit: (digit: string) => void;
  /** Нажат backspace. */
  readonly onBackspace: () => void;
  /** Нажато «очистить». */
  readonly onClear: () => void;
}

/** Цифровая клавиатура: 1–9 / очистить · 0 · backspace (§5). */
export const DigitPad = memo(function DigitPad({
  onDigit,
  onBackspace,
  onClear,
}: DigitPadProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="inline-grid grid-cols-3 gap-2">
      {DIGITS.map((digit) => (
        <button
          key={digit}
          type="button"
          className={KEY_CLASS}
          aria-label={t('measurement.digit.aria', { digit })}
          onClick={() => onDigit(digit)}
        >
          {digit}
        </button>
      ))}
      <button type="button" className={KEY_CLASS} onClick={onClear}>
        {t('measurement.digitPad.clear')}
      </button>
      <button
        type="button"
        className={KEY_CLASS}
        aria-label={t('measurement.digit.aria', { digit: '0' })}
        onClick={() => onDigit('0')}
      >
        0
      </button>
      <button
        type="button"
        className={KEY_CLASS}
        aria-label={t('measurement.digitPad.backspace')}
        onClick={onBackspace}
      >
        ⌫
      </button>
    </div>
  );
});
