/**
 * TASK-031 §5/§13/§16: поле «когда измерено». По умолчанию «сейчас» — отображение
 * по Intl (formatDateTime TASK-013, стена nowMs). Кнопка «Изменить» → простые
 * поля input type=date/time (TD-11), префилл текущими датой/временем; заднее
 * число разрешено, будущее — клиентская ошибка (assembly, §13) подсветкой.
 * takenAt собирается на submit — отображение здесь информационное.
 */
import { useTranslation } from 'react-i18next';

import type { FieldError } from '../api/use-add-measurement';
import type { When } from '../model/form-store';
import { formatDateTime } from '../../../lib/i18n-date';
import { tzOffsetMinOf } from '../model/taken-at';

/** Props поля «когда»: контролируемое значение + переходы режимов (§12). */
export interface WhenFieldProps {
  /** «Сейчас» или ручной ввод {date, time}. */
  readonly when: When;
  /** Момент открытия формы — для отображения и префилла (submit берёт своё, §13). */
  readonly nowMs: number;
  /** Вернуться к «сейчас». */
  readonly onNow: () => void;
  /** «Изменить»/правка полей: новая пара дата/время. */
  readonly onManual: (date: string, time: string) => void;
  /** Ошибка поля (futureTime/неполный ввод — §13). */
  readonly error?: FieldError;
}

/** Локальная стена nowMs → 'YYYY-MM-DD' (префилл input type=date). */
function dateStringOf(nowMs: number): string {
  const d = new Date(nowMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Локальная стена nowMs → 'HH:MM' (префилл input type=time). */
function timeStringOf(nowMs: number): string {
  const d = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

/** Поле «когда измерено» (§5). */
export function WhenField({ when, nowMs, onNow, onManual, error }: WhenFieldProps): JSX.Element {
  const { t } = useTranslation();
  // Статический id ошибки: оба поля ссылаются на один текст (§16).
  const errorId = 'when-error';
  const manual = when !== 'now';

  const label = t('measurement.when.label');
  return (
    <fieldset className="border-0 p-0">
      <legend className="text-sm text-accent">{label}</legend>
      {manual ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="when-date" className="text-sm text-accent">
              {t('measurement.when.date')}
            </label>
            <input
              id="when-date"
              type="date"
              value={when.date}
              onChange={(event) => onManual(event.target.value, when.time)}
              aria-invalid={error === undefined ? undefined : true}
              aria-describedby={error === undefined ? undefined : errorId}
              className="min-h-11 rounded-md border border-border bg-bg px-2 text-base text-text"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="when-time" className="text-sm text-accent">
              {t('measurement.when.time')}
            </label>
            <input
              id="when-time"
              type="time"
              value={when.time}
              onChange={(event) => onManual(when.date, event.target.value)}
              aria-invalid={error === undefined ? undefined : true}
              aria-describedby={error === undefined ? undefined : errorId}
              className="min-h-11 rounded-md border border-border bg-bg px-2 text-base text-text"
            />
          </div>
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-3 text-base text-text hover:bg-accent/10"
            onClick={onNow}
          >
            {t('measurement.when.backToNow')}
          </button>
        </div>
      ) : (
        <div className="flex min-h-11 flex-wrap items-center gap-3">
          {/* Настенное время «сейчас» в формате Intl (TASK-013, §17). */}
          <time>
            {formatDateTime(
              { utcMs: nowMs, tzOffsetMin: tzOffsetMinOf(nowMs) },
              { preset: 'datetime' },
            )}
          </time>
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-3 text-base text-text hover:bg-accent/10"
            onClick={() => onManual(dateStringOf(nowMs), timeStringOf(nowMs))}
          >
            {t('measurement.when.change')}
          </button>
        </div>
      )}
      {error !== undefined && (
        <span id={errorId} role="alert" className="text-sm text-accent">
          {t(error.messageKey, error.params)}
        </span>
      )}
    </fieldset>
  );
}
