/**
 * TASK-033 §5/§13/§16: группа дня — заголовок h3 («Сегодня» / «Вчера» / дата
 * Intl по настенному времени первой записи группы) + ul строк дня (li —
 * MeasurementRow). Класс заголовка — dayKind(group.key, nowMs): сравнение
 * настенных дат, полночь — по настенной дате записи (§13); nowMs приходит из
 * экрана (один на рендер — стабильные заголовки внутри прохода, тестопригодно).
 */
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../../lib/i18n-date';
import { dayKind, type MeasurementDayGroup } from '../model/wall-date';
import { MeasurementRow } from './MeasurementRow';

/** Props группы: данные дня + «сейчас» экрана (§13). */
export interface DayGroupProps {
  readonly group: MeasurementDayGroup;
  readonly nowMs: number;
}

/** Заголовок дня: относительные имена для сегодня/вчера, иначе — дата Intl (§17). */
function useDayTitle(group: MeasurementDayGroup, nowMs: number): string {
  const { t } = useTranslation();
  const kind = dayKind(group.key, nowMs);
  if (kind === 'today') {
    return t('measurement.history.today');
  }
  return kind === 'yesterday'
    ? t('measurement.history.yesterday')
    : formatDateTime(group.instant, { preset: 'date' });
}

/** Группа дня журнала (§16: ul по дням → li, заголовки — h3). */
export function DayGroup({ group, nowMs }: DayGroupProps): JSX.Element {
  const title = useDayTitle(group, nowMs);

  return (
    <section data-testid="day-group" className="mb-4">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600 dark:text-neutral-300">{title}</h3>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
        {group.items.map((measurement) => (
          <MeasurementRow key={measurement.id} measurement={measurement} />
        ))}
      </ul>
    </section>
  );
}
