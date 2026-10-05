/**
 * TASK-033 §5/§13/§16: группа дня — заголовок h3 («Сегодня» / «Вчера» / дата
 * Intl по настенному времени первой записи группы) + ul строк дня (li —
 * MeasurementRow). Класс заголовка — dayKind(group.key, nowMs): сравнение
 * настенных дат, полночь — по настенной дате записи (§13); nowMs приходит из
 * экрана (один на рендер — стабильные заголовки внутри прохода, тестопригодно).
 */
import { useTranslation } from 'react-i18next';

import type { MeasurementDto } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { dayKind, type MeasurementDayGroup } from '../model/wall-date';
import { MeasurementRow } from './MeasurementRow';

/** Props группы: данные дня + «сейчас» экрана (§13); TASK-038: меню строк. */
export interface DayGroupProps {
  readonly group: MeasurementDayGroup;
  readonly nowMs: number;
  /** TASK-038 §5: меню действий строк — прозрачный колбэк от экрана (§15). */
  readonly onRowAction?: (measurement: MeasurementDto, action: 'edit' | 'delete') => void;
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

/** Группа дня журнала (§16: ul по дням → li, заголовки — h2 под h1 экрана, TASK-108). */
export function DayGroup({ group, nowMs, onRowAction }: DayGroupProps): JSX.Element {
  const title = useDayTitle(group, nowMs);

  return (
    <section data-testid="day-group" className="mb-4">
      <h2 className="mb-1 text-sm font-semibold text-muted">{title}</h2>
      <ul className="divide-y divide-border">
        {group.items.map((measurement) => (
          <MeasurementRow
            key={measurement.id}
            measurement={measurement}
            onRowAction={onRowAction}
          />
        ))}
      </ul>
    </section>
  );
}
