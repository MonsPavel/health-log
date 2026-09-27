/**
 * TASK-033 §5/§14/§16: строка журнала — компактная запись дня: время (HH:MM),
 * 125/82, «70 уд/мин» (пульс опционален), рука (title-атрибут — «иконка» §5,
 * MVP без библиотеки иконок: компактный текст-бейдж с подсказкой), заметка —
 * обрезанные 40 символов в подстроке (§14 — экранирование делает React) с полным
 * текстом в title.
 *
 * TASK-042 §5/§13: флаг-место — FlagBadges (critical-бейдж кнопкой → панель
 * TASK-041, irregular — tooltip; без флагов — пусто, место не резервируется).
 *
 * TASK-038 §5/§16: меню действий (⋮, RowMenu): «Изменить»/«Удалить». Единственный
 * колбэк onRowAction(measurement, action) — стабильная идентичность между
 * рендерами не ломает memo (§15); решение о правке/удалении принимает экран.
 *
 * TASK-048 §13 (аудит крупного режима): flex-wrap — на масштабах 112/125%
 * содержимое строки переносится, а не перекрывается; единственная обрезка —
 * заметка ellipsis с полным текстом в title (разрешено §5).
 *
 * §15: memo на Row — 200 строк без виртуализации; ре-рендер группы — по id.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { MeasurementDto } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { FlagBadges } from './FlagBadges';
import { RowMenu } from './RowMenu';

/** Лимит заметки в строке (§14): длиннее — обрезка с многоточием, полный текст в title. */
const NOTE_ROW_LENGTH = 40;

/** Подписи руки — литералы (§22: динамических ключей нет; прецедент FIELD_LABEL_KEY). */
const ARM_KEY: Readonly<
  Record<MeasurementDto['arm'], 'measurement.history.armLeft' | 'measurement.history.armRight'>
> = {
  left: 'measurement.history.armLeft',
  right: 'measurement.history.armRight',
};

/** Обрезка заметки для подстроки строки (§14). */
function truncateNote(note: string): string {
  return note.length > NOTE_ROW_LENGTH ? `${note.slice(0, NOTE_ROW_LENGTH)}…` : note;
}

/** Props строки: DTO + меню действий — memo сравнивает по ссылке записи и колбэка (§15). */
export interface MeasurementRowProps {
  readonly measurement: MeasurementDto;
  /** TASK-038 §5: меню действий строки; решение (edit/delete) принимает экран. */
  readonly onRowAction?: (measurement: MeasurementDto, action: 'edit' | 'delete') => void;
}

/** Строка записи журнала (§16: читаемая последовательность время → давление → пульс → рука). */
export const MeasurementRow = memo(function MeasurementRow({
  measurement,
  onRowAction,
}: MeasurementRowProps): JSX.Element {
  const { t } = useTranslation();
  const armLabel = t(ARM_KEY[measurement.arm]);
  const takenAt = {
    utcMs: measurement.takenAtUtcMs,
    tzOffsetMin: measurement.tzOffsetMin,
  };

  return (
    <li
      data-testid="measurement-row"
      className="flex flex-wrap items-baseline gap-3 px-1 py-1.5 text-sm"
    >
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
        <span title={measurement.note} className="truncate text-xs text-neutral-500">
          {truncateNote(measurement.note)}
        </span>
      )}
      {/* TASK-042 §5/§13: бейджи флагов (FlagBadges); без флагов — пусто, место не
          резервируется (компактность, §13). ml-auto — якорь правого края строки. */}
      <span data-testid="row-flag-slot" className="ml-auto flex shrink-0 items-center gap-1.5">
        <FlagBadges measurement={measurement} />
      </span>
      {/* TASK-038 §5: меню действий записи — «Изменить»/«Удалить». */}
      <RowMenu
        measurementId={measurement.id}
        onEdit={() => onRowAction?.(measurement, 'edit')}
        onDelete={() => onRowAction?.(measurement, 'delete')}
      />
    </li>
  );
});
