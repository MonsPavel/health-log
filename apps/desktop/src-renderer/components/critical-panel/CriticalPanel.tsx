/**
 * TASK-041 §5/§10/§13/§16: панель критических значений (полный текст SRS 04
 * FR-7.4). duty-of-care: молчание при 200/130 недопустимо; «вызываем скорую за
 * вас» — медизделие (R-1) — панель только информирует, пользователь звонит сам
 * (§5: tel:-ссылок НЕТ, десктоп без телефона).
 *
 * ТОН (§10/§13): «спокойный факт, не паника» — заметная акцентная рамка (НЕ
 * красная), без диагнозов (запрет-тест §14), без императивов паники; есть
 * конкретный шаг («Немедленно обратитесь…» + номера). Для high — полный текст
 * FR-7.4: интро с {pressure} (значения записи либо порог ≥180/120, когда
 * значения не переданы), список симптомов, призыв, номера из реестра по языку
 * интерфейса (emergency-numbers.ts). Для low — мягкий вариант (§5: SRS дословно
 * не даёт — формулировка из UC-06, ревизия TASK-110) без номеров.
 *
 * ДОСТУПНОСТЬ (§16): high — role="alert" (озвучить сразу); low — aria-live
 * polite; dismiss-кнопка «Понятно, скрыть» — обычный button (в фокус-порядке);
 * контраст — токены bg/text (AA). Панель НЕ блокирует работу (AC-6.1): решение
 * о скрытии — у владельца через onDismiss (§5: dismiss — в пределах сессии
 * этой записи; подавления между записями нет, §13).
 *
 * I18N (§17): все слова — ключи каталога critical.* (components/critical/ru.json);
 * номера — из реестра по i18n.language; значения — через params. Динамические
 * ключи запрещены (§22) — литеральные карты, как FIELD_LABEL_KEY (TASK-032).
 */
import type { HTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import { getEmergencyNumbers } from './emergency-numbers';

/** Флаг критичности из политики TASK-020 (значение поля flags.criticalValue). */
export type CriticalFlag = 'high' | 'low';

/** Props панели (§5): {flag, onDismiss}; значения записи — для подстановки {pressure}. */
export interface CriticalPanelProps {
  /** Вариант панели: high — полный текст FR-7.4, low — мягкий (§5). */
  readonly flag: CriticalFlag;
  /** «Понятно, скрыть»: владелец решает, скрывать ли (§10). */
  readonly onDismiss: () => void;
  /** СДА записи — подставляется в текст вместо порога (§13 params {sys, dia}). */
  readonly sys?: number;
  /** ДДА записи — подставляется в текст вместо порога (§13 params {sys, dia}). */
  readonly dia?: number;
}

/** Ключи порогов без значений — литералы (§22: динамические ключи запрещены). */
const THRESHOLD_KEY: Readonly<
  Record<CriticalFlag, 'critical.panel.thresholds.high' | 'critical.panel.thresholds.low'>
> = {
  high: 'critical.panel.thresholds.high',
  low: 'critical.panel.thresholds.low',
};

/**
 * Панель критических значений (§2). Презентационная: данные — props + реестр
 * номеров; скрытие — onDismiss владельцу (§10). Никаких сетевых вызовов (§14).
 */
export function CriticalPanel({ flag, onDismiss, sys, dia }: CriticalPanelProps): JSX.Element {
  const { t, i18n } = useTranslation();

  // §13: значения записи в тексте (190/125); без значений — порог SRS («≥180/120»).
  const pressure =
    sys !== undefined && dia !== undefined ? `${sys}/${dia}` : t(THRESHOLD_KEY[flag]);

  // §5/§17: номера — данные реестра по языку интерфейса; слова — ключи каталога.
  const numbers = getEmergencyNumbers(i18n.language);
  let numbersText: string;
  if (numbers === undefined) {
    numbersText = t('critical.panel.numbers.fallback');
  } else if (numbers.unified !== undefined) {
    numbersText = t('critical.panel.numbers.withUnified', {
      primary: numbers.primary,
      primaryLabel: numbers.label,
      unified: numbers.unified,
      unifiedLabel: t('critical.panel.numbers.unifiedLabel'),
    });
  } else {
    numbersText = t('critical.panel.numbers.single', { primary: numbers.primary });
  }

  // §16: high — assertive (role="alert"), low — polite.
  const a11y: HTMLAttributes<HTMLDivElement> =
    flag === 'high' ? { role: 'alert' } : { 'aria-live': 'polite' };

  return (
    <div
      data-testid="critical-panel"
      {...a11y}
      className="rounded-md border-2 border-accent bg-bg p-4"
    >
      {flag === 'high' ? (
        <>
          <p className="font-semibold text-text">{t('critical.panel.high.intro', { pressure })}</p>
          <p className="mt-2 text-text">{t('critical.panel.high.symptomsLead')}</p>
          <ul className="mt-1 list-disc pl-5 text-text">
            <li>{t('critical.panel.high.symptomHeadache')}</li>
            <li>{t('critical.panel.high.symptomChestPain')}</li>
            <li>{t('critical.panel.high.symptomBreathlessness')}</li>
            <li>{t('critical.panel.high.symptomSpeechOrVision')}</li>
          </ul>
          <p className="mt-2 font-semibold text-text">{t('critical.panel.high.cta')}</p>
          <p className="mt-1 text-text">
            {t('critical.panel.high.numbersLead')} {numbersText}
          </p>
        </>
      ) : (
        <p className="text-text">{t('critical.panel.low.body', { pressure })}</p>
      )}

      <div className="mt-3">
        <button
          type="button"
          data-testid="critical-panel-dismiss"
          onClick={onDismiss}
          className="min-h-11 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text"
        >
          {t('critical.panel.dismiss')}
        </button>
      </div>
    </div>
  );
}
