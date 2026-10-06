/**
 * TASK-061 §2/§5/§13/§16/§17: карточка «Последнее измерение» — главная карточка
 * сводки: давление КРУПНО (125/82), пульс, «когда» («Сегодня 08:12»/«Вчера»/
 * дата Intl — настенные компоненты записи через model/wall-date + lib/i18n-date,
 * прецедент DayGroup TASK-033; граница полуночи — по настенной дате, §13).
 *
 * КРИТИЧЕСКОЕ (§5/§13): флаг critical записи (server-computed TASK-042) →
 * кликабельный бейдж FlagBadges TASK-042 → мини-панель срочности TASK-041
 * (CriticalPanel в диалоге — тот же механизм, что в журнале; значения записи
 * подставлены в текст). Без флага — бейджа и панели нет (место не резервируется).
 *
 * CTA (§5/§16): «Добавить измерение» — ГЛАВНОЕ действие экрана, крупная ≥48px
 * (min-h-12 = 3rem; rem — растёт с масштабом текста FR-8.2, правило 048).
 *
 * ДОСТУПНОСТЬ (§16): section + h3; крупное давление — обычный текст (скринридер
 * читает «125 на 82» естественным образом из содержимого «125/82» + подписи).
 */
import { useTranslation } from 'react-i18next';

import type { MeasurementDto } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { dayKind, wallDateKey } from '../../measurement/model/wall-date';
import { FlagBadges } from '../../measurement/ui/FlagBadges';

/** Свойства карточки (§5): последняя запись + «сейчас» экрана + действие CTA. */
export interface LastMeasurementCardProps {
  readonly measurement: MeasurementDto;
  /** «Сейчас» — один на рендер (стабильные подписи, прецедент DayGroup §13). */
  readonly nowMs: number;
  /** Клик CTA «Добавить измерение» (журнал/форма — решает экран). */
  readonly onAdd: () => void;
}

/** Карточка «Последнее измерение» (§5): значения, флаги, CTA. */
export function LastMeasurementCard({
  measurement,
  nowMs,
  onAdd,
}: LastMeasurementCardProps): JSX.Element {
  const { t } = useTranslation();

  // «когда» (§5): сегодня/вчера по настенным ключам дня, иначе — дата Intl.
  const instant = { utcMs: measurement.takenAtUtcMs, tzOffsetMin: measurement.tzOffsetMin };
  const wallKey = wallDateKey(instant);
  const kind = dayKind(wallKey, nowMs);
  const when =
    kind === 'today'
      ? t('dashboard.last.whenToday', { time: formatDateTime(instant, { preset: 'time' }) })
      : kind === 'yesterday'
        ? t('dashboard.last.whenYesterday', { time: formatDateTime(instant, { preset: 'time' }) })
        : formatDateTime(instant, { preset: 'datetime' });

  return (
    <section
      data-testid="last-measurement-card"
      className="rounded-[16px] bg-surface p-4 md:col-span-2"
    >
      <h2 className="mb-2 text-sm font-semibold text-muted">{t('dashboard.last.title')}</h2>
      <p data-testid="last-bp" className="text-4xl font-semibold tracking-tight">
        {measurement.sys}/{measurement.dia}
      </p>
      {measurement.pulse !== undefined && (
        <p data-testid="last-pulse" className="mt-1 text-base">
          {t('dashboard.last.pulse', { pulse: measurement.pulse })}
        </p>
      )}
      <p data-testid="last-when" className="mt-1 text-sm text-muted">
        {when}
      </p>
      <div className="mt-2">
        <FlagBadges measurement={measurement} />
      </div>
      <button
        type="button"
        data-testid="dashboard-add"
        onClick={onAdd}
        className="mt-4 min-h-12 rounded-xl bg-accent px-6 text-base font-semibold text-bg hover:opacity-90"
      >
        {t('dashboard.home.add')}
      </button>
    </section>
  );
}
