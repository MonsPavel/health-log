/**
 * TASK-033 §5/§14/§16: строка журнала — компактная запись дня: время (HH:MM),
 * 125/82, «70 уд/мин» (пульс опционален), рука (title-атрибут — «иконка» §5,
 * MVP без библиотеки иконок: компактный текст-бейдж с подсказкой), заметка —
 * обрезанные 40 символов в подстроке (§14 — экранирование делает React) с полным
 * текстом в title. Флаг-место — пустой aria-hidden span: бейджи флагов — TASK-042.
 *
 * §15: memo на Row — 200 строк без виртуализации; ре-рендер группы — по id.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { MeasurementDto } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';

/** Лимит заметки в строке (§14): длиннее — обрезка с многоточием, полный текст в title. */
const NOTE_ROW_LENGTH = 40;

/** Подписи руки — литералы (§22: динамических ключей нет; прецедент FIELD_LABEL_KEY). */
const ARM_KEY: Readonly<Record<MeasurementDto['arm'], 'measurement.history.armLeft' | 'measurement.history.armRight'>> = {
  left: 'measurement.history.armLeft',
  right: 'measurement.history.armRight',
};

/** Обрезка заметки для подстроки строки (§14). */
function truncateNote(note: string): string {
  return note.length > NOTE_ROW_LENGTH ? `${note.slice(0, NOTE_ROW_LENGTH)}…` : note;
}

/** Props строки: только DTO — memo сравнивает по ссылке записи (§15). */
export interface MeasurementRowProps {
  readonly measurement: MeasurementDto;
}

/** Строка записи журнала (§16: читаемая последовательность время → давление → пульс → рука). */
export const MeasurementRow = memo(function MeasurementRow({
  measurement,
}: MeasurementRowProps): JSX.Element {
  const { t } = useTranslation();
  const armLabel = t(ARM_KEY[measurement.arm]);
  const takenAt = {
    utcMs: measurement.takenAtUtcMs,
    tzOffsetMin: measurement.tzOffsetMin,
  };

  return (
    <li data-testid="measurement-row" className="flex items-baseline gap-3 px-1 py-1.5 text-sm">
      <span className="shrink-0 tabular-nums text-neutral-500">
        {formatDateTime(takenAt, { preset: 'time' })}
      </span>
      <span className="font-medium tabular-nums">
        {measurement.sys}/{measurement.dia}
      </span>
      {measurement.pulse !== undefined ? (
        <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
          {t('measurement.history.pulse', { value: measurement.pulse })}
        </span>
      ) : null}
      <span title={armLabel} className="shrink-0 text-xs text-neutral-500">
        {armLabel}
      </span>
      {measurement.note === undefined || measurement.note === '' ? null : (
        <span
          title={measurement.note}
          className="truncate text-xs text-neutral-500"
        >
          {truncateNote(measurement.note)}
        </span>
      )}
      {/* Флаг-место (TASK-042 — бейджи): пока пусто, из a11y-дерева скрыт (§16). */}
      <span aria-hidden="true" data-testid="row-flag-slot" className="ml-auto" />
    </li>
  );
});
