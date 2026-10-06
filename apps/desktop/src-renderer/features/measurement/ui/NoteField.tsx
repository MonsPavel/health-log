/**
 * TASK-031 §5/§13/§16: заметка — textarea ≤500 со счётчиком; maxlength берётся
 * ИЗ СХЕМЫ contracts (max_length → NOTE_MAX, единая истина — model/schema-bounds).
 * Экранирование — React (§14). Ошибка: aria-invalid + aria-describedby (§16).
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { FieldError } from '../api/use-add-measurement';
import { noteMaxLength } from '../model/schema-bounds';

/** Props поля заметки: контролируемое значение + ошибка валидации (§13). */
export interface NoteFieldProps {
  /** Текущий текст. */
  readonly value: string;
  /** Смена текста. */
  readonly onChange: (note: string) => void;
  /** Ошибка поля (например errors.noteTooLong с params.max — §17). */
  readonly error?: FieldError;
}

/** Поле заметки со счётчиком (§5). */
export function NoteField({ value, onChange, error }: NoteFieldProps): JSX.Element {
  const { t } = useTranslation();
  const errorId = useId();
  // Граница из схемы (§13); fallback 500 = NOTE_MAX TASK-028 — на случай
  // поломки интроспекции (ловится тестом maxlength=500).
  const max = noteMaxLength() ?? 500;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="note" className="text-sm text-accent">
        {t('measurement.fields.note')}
      </label>
      <textarea
        id="note"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        maxLength={max}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className="min-h-11 rounded-[10px] bg-fill p-2 text-base text-text"
      />
      <span className="text-xs text-accent" aria-hidden="true">
        {t('measurement.note.counter', { length: value.length, max })}
      </span>
      {error !== undefined && (
        <span id={errorId} role="alert" className="text-sm text-accent">
          {t(error.messageKey, error.params)}
        </span>
      )}
    </div>
  );
}
