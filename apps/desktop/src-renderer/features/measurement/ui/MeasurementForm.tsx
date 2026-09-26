/**
 * TASK-031 §5/§10/§13/§16: форма быстрого ввода измерения (цель ≤15 с, BG-1).
 *
 * Композиция: fieldset давления (sys/dia) + пульс (крупные кнопки DigitPad, автофокус
 * sys, авто-переход по 3 цифрам — эвристика §13, Enter = сохранить) + флаг
 * «неровный пульс» + рука (сегмент) + заметка + «когда» + сохранение.
 *
 * Валидация — ТА ЖЕ zod-схема contracts через assembleAddRequest (§13): ошибки
 * подсвечивают поля (aria-invalid + aria-describedby) без блокировки ввода;
 * сохранение заблокировано, пока сборка не проходит. takenAt — на момент submit.
 *
 * Состояния (§10): idle → submitting (кнопка disabled + подпись «Сохранение…») →
 * saved (тост role="status" + сброс чисел/заметки; рука/флаг остаются) / error
 * (серверная — тост useToast с messageKey; клиентская — подсветка полей).
 * Черновик — zustand store (§12, без persist — TASK-039); мутация — useMutation
 * с инвалидацией ['measurements'] (§12). Ре-рендер — узкие селекторы store (§15).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { MeasurementAddResponse } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import {
  assembleAddRequest,
  useAddMeasurement,
  type FieldErrors,
} from '../api/use-add-measurement';
import { useFormStore } from '../model/form-store';
import { ArmSegment } from './ArmSegment';
import { DigitPad } from './DigitPad';
import { NoteField } from './NoteField';
import { WhenField } from './WhenField';

/** Числовые поля формы. */
type NumericField = 'sys' | 'dia' | 'pulse';

/** Порядок авто-перехода по 3 цифрам (§13): sys→dia→pulse, из pulse — нет. */
const NEXT_FIELD: Readonly<Record<NumericField, NumericField | null>> = {
  sys: 'dia',
  dia: 'pulse',
  pulse: null,
};

/** Подписи числовых полей — литералы (§22: динамические ключи запрещены). */
const FIELD_LABEL_KEY: Readonly<
  Record<
    NumericField,
    'measurement.fields.sys' | 'measurement.fields.dia' | 'measurement.fields.pulse'
  >
> = {
  sys: 'measurement.fields.sys',
  dia: 'measurement.fields.dia',
  pulse: 'measurement.fields.pulse',
};

/** Props формы: флаги ответа прокидываются наверх (§11 — TASK-032 решает). */
export interface MeasurementFormProps {
  /** Успех сохранения: {measurement, flags}. */
  readonly onSuccess?: (result: MeasurementAddResponse) => void;
}

/** Поле «сохранено» тоста, мс (мгновенное подтверждение, §10). */
const SAVED_TOAST_MS = 4000;

/** Форма ввода измерения (§2). */
export function MeasurementForm({ onSuccess }: MeasurementFormProps): JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();

  // Узкие селекторы store (§15): подписка на каждое значение отдельно.
  const sys = useFormStore((s) => s.sys);
  const dia = useFormStore((s) => s.dia);
  const pulse = useFormStore((s) => s.pulse);
  const irregular = useFormStore((s) => s.irregular);
  const arm = useFormStore((s) => s.arm);
  const note = useFormStore((s) => s.note);
  const when = useFormStore((s) => s.when);
  const appendDigit = useFormStore((s) => s.appendDigit);
  const removeLastDigit = useFormStore((s) => s.removeLastDigit);
  const clearField = useFormStore((s) => s.clearField);
  const setArm = useFormStore((s) => s.setArm);
  const setIrregular = useFormStore((s) => s.setIrregular);
  const setNote = useFormStore((s) => s.setNote);
  const setWhenNow = useFormStore((s) => s.setWhenNow);
  const setWhenManual = useFormStore((s) => s.setWhenManual);
  const resetAfterSave = useFormStore((s) => s.resetAfterSave);

  /** Момент открытия (отображение «сейчас» и live-валидация); на submit — свежий. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** Активное числовое поле клавиатуры (автофокус sys, §5). */
  const [activeField, setActiveField] = useState<NumericField>('sys');
  /** Показывать «обязательные» ошибки — после первой попытки сохранения. */
  const [submitAttempted, setSubmitAttempted] = useState(false);
  /** Мгновенное подтверждение «Сохранено» (§10). */
  const [saved, setSaved] = useState(false);

  const sysRef = useRef<HTMLInputElement>(null);
  const diaRef = useRef<HTMLInputElement>(null);
  const pulseRef = useRef<HTMLInputElement>(null);
  const inputRefs: Readonly<Record<NumericField, React.RefObject<HTMLInputElement>>> = {
    sys: sysRef,
    dia: diaRef,
    pulse: pulseRef,
  };

  // Автофокус в sys при открытии формы (§5).
  useEffect(() => {
    sysRef.current?.focus();
  }, []);

  // Тост «Сохранено» скрывается сам (§10).
  useEffect(() => {
    if (!saved) {
      return undefined;
    }
    const timer = setTimeout(() => setSaved(false), SAVED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  // Клиентская валидация той же схемой контракта (§13) — live, без блокировки ввода.
  const validation = useMemo(
    () => assembleAddRequest({ sys, dia, pulse, irregular, arm, note, when }, nowMs),
    [sys, dia, pulse, irregular, arm, note, when, nowMs],
  );
  const fieldErrors: FieldErrors = validation.ok ? {} : validation.fieldErrors;
  const isValid = validation.ok;

  /** Ошибка поля показывается, если значение непустое (или была попытка) — пустая форма не «краснеет». */
  const shownError = (field: NumericField | 'note', value: string) => {
    const error = fieldErrors[field];
    if (error === undefined || (value === '' && !submitAttempted)) {
      return undefined;
    }
    return error;
  };
  const whenError = when !== 'now' ? fieldErrors.when : undefined;

  const mutation = useAddMeasurement({
    // Успех (§10/§11): тост, сброс чисел/заметки (рука/флаг остаются), флаги наверх.
    onSuccess: (result) => {
      resetAfterSave();
      setNowMs(Date.now());
      setSubmitAttempted(false);
      setSaved(true);
      onSuccess?.(result);
    },
    // Серверная ошибка — тост с messageKey (§10); поля не трогаем.
    onError: (error) => {
      showToast(error);
    },
  });

  /** Цифра в поле + авто-переход по достижении 3 цифр (§13). */
  const handleDigit = (field: NumericField, digit: string): void => {
    const current = useFormStore.getState()[field];
    appendDigit(field, digit);
    if (NEXT_FIELD[field] !== null && `${current}${digit}`.length === 3) {
      const next = NEXT_FIELD[field];
      setActiveField(next);
      inputRefs[next].current?.focus();
    }
  };

  const handleBackspace = (field: NumericField): void => {
    removeLastDigit(field);
    setActiveField(field);
  };

  const handleClear = (field: NumericField): void => {
    clearField(field);
    setActiveField(field);
  };

  /** Клавиатура числового поля: цифры/Backspace/Enter (§16: Enter = сохранить). */
  const handleKeyDown = (field: NumericField, event: KeyboardEvent<HTMLInputElement>): void => {
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      handleDigit(field, event.key);
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      removeLastDigit(field);
      setActiveField(field);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  /** Submit: takenAt на момент submit (§13); invalid — показать required-ошибки. */
  const submit = (): void => {
    const draft = useFormStore.getState();
    const result = assembleAddRequest(
      {
        sys: draft.sys,
        dia: draft.dia,
        pulse: draft.pulse,
        irregular: draft.irregular,
        arm: draft.arm,
        note: draft.note,
        when: draft.when,
      },
      Date.now(),
    );
    if (!result.ok) {
      setSubmitAttempted(true);
      return;
    }
    mutation.mutate(result.request);
  };

  /** Числовое поле: readonly-ввод со скрытой клавиатурной обработкой (§5/§16). */
  const numberField = (field: NumericField) => {
    const value = field === 'sys' ? sys : field === 'dia' ? dia : pulse;
    const error = shownError(field, value);
    const describedBy = error === undefined ? undefined : `${field}-error`;
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={field} className="text-sm text-accent">
          {t(FIELD_LABEL_KEY[field])}
        </label>
        <input
          ref={inputRefs[field]}
          id={field}
          data-testid={`input-${field}`}
          type="text"
          inputMode="numeric"
          readOnly
          value={value}
          onFocus={() => setActiveField(field)}
          onKeyDown={(event) => handleKeyDown(field, event)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
          className="min-h-11 w-24 rounded-md border border-border bg-bg text-center text-2xl text-text"
        />
        {error !== undefined && (
          <span id={`${field}-error`} role="alert" className="text-sm text-accent">
            {t(error.messageKey, error.params)}
          </span>
        )}
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-4 p-4">
      {/* FR-9.2: обучающая подсказка над формой (§10). */}
      <p className="text-sm text-accent">{t('measurement.form.hint')}</p>

      {/* Мгновенное подтверждение (§10): role="status" — polite для скринридера. */}
      {saved && (
        <div role="status" data-testid="saved-toast" className="text-base font-semibold">
          {t('measurement.form.savedToast')}
        </div>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* §16: fieldset/legend для группы давления. */}
        <fieldset className="border-0 p-0">
          <legend className="text-sm text-accent">{t('measurement.form.pressureLegend')}</legend>
          <div className="flex gap-4">
            {numberField('sys')}
            {numberField('dia')}
          </div>
        </fieldset>

        {numberField('pulse')}

        <label className="flex min-h-11 items-center gap-2 text-base">
          <input
            type="checkbox"
            checked={irregular}
            onChange={(event) => setIrregular(event.target.checked)}
            className="h-5 w-5 accent-[var(--hl-accent)]"
          />
          {t('measurement.fields.irregular')}
        </label>

        <ArmSegment value={arm} onArm={setArm} />

        <NoteField value={note} onChange={setNote} error={shownError('note', note)} />

        <WhenField
          when={when}
          nowMs={nowMs}
          onNow={setWhenNow}
          onManual={setWhenManual}
          error={whenError}
        />

        <button
          type="submit"
          disabled={!isValid || mutation.isPending}
          className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:opacity-50"
        >
          {mutation.isPending ? t('measurement.form.saving') : t('measurement.form.save')}
        </button>
      </form>

      {/* Клавиатура после формы: таб-порядок полей §16 не ломается. */}
      <DigitPad
        onDigit={(digit) => handleDigit(activeField, digit)}
        onBackspace={() => handleBackspace(activeField)}
        onClear={() => handleClear(activeField)}
      />
    </section>
  );
}
