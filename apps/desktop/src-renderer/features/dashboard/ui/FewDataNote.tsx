/**
 * TASK-060 §2/§5/§13/§16/§17: пометка «мало данных» над графиком — точки 1–6
 * (1≤N<AI_MIN_MEASUREMENTS=7; порог kernel приходит готовым флагом
 * stats.insufficientData.tooFewMeasurements — рендерер kernel не импортирует,
 * арх. 03 §4, единый источник с ИИ-честностью TASK-006). График при этом
 * рендерится (§5: НЕ «пустое полотно») — полосу ставит экран.
 *
 * ЧЕСТНОСТЬ (§3, EC-09): «Выводы будут точнее с накоплением» — данных мало,
 * выводов не строим. ДОСТУПНОСТЬ (§16): role="note" СТАТИЧНО (прецедент
 * TrendSummary 059: смена периода перерисовывает пометку, но озвучивать её
 * автоматически не нужно); контраст AA (нейтральный фон + основной текст
 * токенов темы).
 *
 * i18n (§17): ключ dashboard.fewData, params {count}, plural-формы RU —
 * LDML-суффиксы каталога + карта литералов (§22: динамических ключей нет —
 * check-i18n видит каждый; прецедент pulse.hiddenCount TASK-058).
 */
import { useTranslation } from 'react-i18next';

/** Свойства пометки (§5): N измерений за период — от экрана (один stats-ответ). */
export interface FewDataNoteProps {
  /** Число измерений в периоде (count stats-ответа — те же read models, §13). */
  readonly count: number;
}

/** Ключи пометки — LDML-суффиксы каталога (§17; прецедент hiddenCount 058). */
type FewDataKey =
  | 'dashboard.fewData_one'
  | 'dashboard.fewData_few'
  | 'dashboard.fewData_many'
  | 'dashboard.fewData_other';

/** Категория plural → полный литерал ключа (§22: карта литералов, не подстановка). */
const FEW_DATA_KEY: Readonly<Record<'one' | 'few' | 'many' | 'other', FewDataKey>> = {
  one: 'dashboard.fewData_one',
  few: 'dashboard.fewData_few',
  many: 'dashboard.fewData_many',
  other: 'dashboard.fewData_other',
};

/** Ключ пометки по числу (§17): Intl.PluralRules('ru') + карта литералов. */
function fewDataKeyFor(count: number): FewDataKey {
  switch (new Intl.PluralRules('ru').select(count)) {
    case 'one':
      return FEW_DATA_KEY.one;
    case 'few':
      return FEW_DATA_KEY.few;
    case 'many':
      return FEW_DATA_KEY.many;
    default:
      return FEW_DATA_KEY.other;
  }
}

/** Полоса «Мало данных — {N} измерений за период…» над графиком (§5). */
export function FewDataNote({ count }: FewDataNoteProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="few-data-note"
      role="note"
      className="mb-3 rounded-[10px] bg-surface px-3 py-2 text-sm"
    >
      {t(fewDataKeyFor(count), { count })}
    </div>
  );
}
