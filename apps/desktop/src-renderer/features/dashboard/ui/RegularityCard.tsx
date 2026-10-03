/**
 * TASK-061 §2/§5/§13/§16/§17: карточка «Регулярность» домашней сводки — серия
 * дней и дни с измерениями ИЗ ГОТОВОГО stats-ответа 30d (§4: принцип задачи —
 * никаких новых вычислений; longestStreakDays/daysWithMeasurements считает
 * read model 052). US-16 — мягкая геймификация: поддерживает, не ругает.
 *
 * GOLDEN-тексты (§13, тон FR-4.4): 0 дней → «Начните сегодня — это просто»
 * (без вины); 1 → «Серия: 1 день — отлично»; N → «Серия: N дней» (ICU plural
 * RU — LDML-суффиксы каталога + карта литералов §22, прецедент FewDataNote 060;
 * 0 в ru-PluralRules — many, но ветка 0 перехватывается раньше текстом-акцентом).
 *
 * ДОСТУПНОСТЬ (§16): карточка — section с h3; серия — НЕ «ошибка/успех» цветом
 * (нейтральный акцент, никакого alert/status — скринридер читает полный текст).
 */
import { useTranslation } from 'react-i18next';

import type { PeriodStatisticsDto } from '@hl/contracts';

/** Свойства карточки (§5): stats-ответ 30d (серия + дни с измерениями). */
export interface RegularityCardProps {
  readonly stats: PeriodStatisticsDto;
}

/** Ключи серии — LDML-суффиксы каталога (§17; нулевая серия — отдельный текст). */
type StreakKey =
  | 'dashboard.regularity.streak_one'
  | 'dashboard.regularity.streak_few'
  | 'dashboard.regularity.streak_many'
  | 'dashboard.regularity.streak_other';

/** Ключи «дней с измерениями» — LDML-суффиксы каталога (§17). */
type DaysKey =
  | 'dashboard.regularity.days_one'
  | 'dashboard.regularity.days_few'
  | 'dashboard.regularity.days_many'
  | 'dashboard.regularity.days_other';

/** Категория plural → полный литерал ключа (§22: карта литералов, не подстановка). */
const STREAK_KEY: Readonly<Record<'one' | 'few' | 'many' | 'other', StreakKey>> = {
  one: 'dashboard.regularity.streak_one',
  few: 'dashboard.regularity.streak_few',
  many: 'dashboard.regularity.streak_many',
  other: 'dashboard.regularity.streak_other',
};

const DAYS_KEY: Readonly<Record<'one' | 'few' | 'many' | 'other', DaysKey>> = {
  one: 'dashboard.regularity.days_one',
  few: 'dashboard.regularity.days_few',
  many: 'dashboard.regularity.days_many',
  other: 'dashboard.regularity.days_other',
};

/** Ключ по числу (§17): Intl.PluralRules('ru') + карта литералов. */
function streakKeyFor(count: number): StreakKey {
  switch (new Intl.PluralRules('ru').select(count)) {
    case 'one':
      return STREAK_KEY.one;
    case 'few':
      return STREAK_KEY.few;
    case 'many':
      return STREAK_KEY.many;
    default:
      return STREAK_KEY.other;
  }
}

function daysKeyFor(count: number): DaysKey {
  switch (new Intl.PluralRules('ru').select(count)) {
    case 'one':
      return DAYS_KEY.one;
    case 'few':
      return DAYS_KEY.few;
    case 'many':
      return DAYS_KEY.many;
    default:
      return DAYS_KEY.other;
  }
}

/** Карточка «Регулярность» (§5): серия дней + дни с измерениями за 30 дней. */
export function RegularityCard({ stats }: RegularityCardProps): JSX.Element {
  const { t } = useTranslation();
  const streak = stats.longestStreakDays;

  return (
    <section data-testid="regularity-card" className="rounded-md border border-border p-4">
      <h2 className="mb-2 text-sm font-semibold text-neutral-600 dark:text-neutral-300">
        {t('dashboard.regularity.title')}
      </h2>
      <p data-testid="regularity-streak" className="text-xl font-semibold">
        {streak === 0
          ? t('dashboard.regularity.streakZero')
          : t(streakKeyFor(streak), { count: streak })}
      </p>
      <p
        data-testid="regularity-days"
        className="mt-1 text-sm text-neutral-500 dark:text-neutral-400"
      >
        {t(daysKeyFor(stats.daysWithMeasurements), { count: stats.daysWithMeasurements })}
      </p>
    </section>
  );
}
