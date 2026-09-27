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
 *
 * TASK-038 §4/§5/§10/§22: форма — единственный редактор записи (арх. 06 §5) —
 * режим edit управляется store-полем editingId: заголовок «Изменение записи»
 * (form.editTitle), submit → measurements/update (assembleUpdateRequest — та же
 * валидация, что у add), успех → возврат к режиму add (владелец закрывает вид —
 * тост «Правка применена» и фокус-возврат в строку решает экран); Esc/«Отмена» →
 * cancelEdit (§5: возврат к режиму add без изменений) с dirty-барьером §22
 * (AlertDialog «Закрыть без сохранения?» — защита правки от потери).
 *
 * TASK-039 §5/§16: черновик персистится store'ом (`hl.formDraft`/`hl.formPrefs`):
 * при маунте после перезапуска с непустым черновиком — тост «Черновик восстановлен»
 * (role="status", один раз — consumeDraftRestored); кнопка «Очистить» чистит
 * черновиковые поля (рука/флаг — prefs — остаются).
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { MeasurementAddResponse, MeasurementFlags } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import {
  assembleAddRequest,
  useAddMeasurement,
  type FieldErrors,
} from '../api/use-add-measurement';
import { useDeleteMeasurement } from '../api/use-delete-measurement';
import { assembleUpdateRequest, useUpdateMeasurement } from '../api/use-update-measurement';
import { isEditDirty, useFormStore } from '../model/form-store';
import { parseBpPair } from '../model/parse-bp-pair';
import { ArmSegment } from './ArmSegment';
import { ConfirmFlagsDialog } from './ConfirmFlagsDialog';
import { DigitPad } from './DigitPad';
import { NoteField } from './NoteField';
import { WhenField } from './WhenField';

/** Числовые поля формы. */
type NumericField = 'sys' | 'dia' | 'pulse';

/**
 * TASK-032 §5: есть ли во флагах ответа add повод для диалога «Проверьте значения»
 * (typo-подсказка, дубль, критическое значение — любое).
 */
function hasFlags(flags: MeasurementFlags): boolean {
  return flags.typo !== undefined || flags.duplicate === true || flags.criticalValue !== undefined;
}

/** Порядок авто-перехода по 3 цифрам (§13): sys→dia→pulse, из pulse — нет. */
const NEXT_FIELD: Readonly<Record<NumericField, NumericField | null>> = {
  sys: 'dia',
  dia: 'pulse',
  pulse: null,
};

/** Поля с умной вставкой пары из буфера (TASK-040 §5): sys и dia — pulse не включён. */
type PasteField = Exclude<NumericField, 'pulse'>;

/** Одиночное число ≤3 цифр — штатная вставка в текущее поле (TASK-040 §5). */
const SINGLE_NUMBER_RE = /^\s*(\d{1,3})\s*$/;

/** Подписи числовых полей — литералы (§22: динамические ключи запрещены). */const FIELD_LABEL_KEY: Readonly<
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
  /** TASK-038: правка применена (id) — владелец закрывает вид, тост и фокус в строку (§16). */
  readonly onEditSuccess?: (id: string) => void;
  /** TASK-038: отмена формы (Esc/«Отмена», NOT_FOUND при правке) — владелец закрывает вид. */
  readonly onCancel?: () => void;
}

/** Поле «сохранено» тоста, мс (мгновенное подтверждение, §10). */
const SAVED_TOAST_MS = 4000;

/** Форма ввода измерения (§2); с TASK-038 — также редактор записи (§4). */
export function MeasurementForm({
  onSuccess,
  onEditSuccess,
  onCancel,
}: MeasurementFormProps): JSX.Element {
  const { t } = useTranslation();
  const { showToast } = useToast();

  // Узкие селекторы store (§15): подписка на каждое значение отдельно.
  const editingId = useFormStore((s) => s.editingId);
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
  const setPressure = useFormStore((s) => s.setPressure);
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
  /**
   * TASK-039 §5/§16: тост «Черновик восстановлен» — один раз после запуска,
   * если при гидрации store восстановлен непустой черновик (transient-флаг
   * draftRestored, consumeDraftRestored).
   */
  const [draftRestoredToast, setDraftRestoredToast] = useState(false);
  /**
   * TASK-040 §5/§10/§16: тост-подсказка «Не удалось разобрать вставку» (role="status",
   * не блокирующий) — при paste-мусоре в sys/dia; поля не тронуты, фокус не уходит.
   */
  const [pasteFailedToast, setPasteFailedToast] = useState(false);
  /**
   * TASK-032 §5/§10: ответ add с флагами — диалог «Проверьте значения» открыт.
   * Черновик store НЕ очищается до подтверждения (§10: «он не очищался до
   * подтверждения» — значения возвращаются в форму удалением записи).
   */
  const [flagsDialog, setFlagsDialog] = useState<MeasurementAddResponse | null>(null);
  /**
   * TASK-032 §10: отложенный фокус в sys после успешного «Удалить и исправить» —
   * эффектом ПОСЛЕ размонтирования диалога (Radix при закрытии восстанавливает
   * фокус и перебил бы синхронный вызов).
   */
  const [focusSysAfterClose, setFocusSysAfterClose] = useState(false);
  /**
   * TASK-038 §22: диалог «Закрыть без сохранения?» — барьер при отмене dirty-правки
   * (потеря правки при закрытии формы без сохранения — риск §22, защита данных).
   */
  const [discardOpen, setDiscardOpen] = useState(false);

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

  // TASK-039 §5: consume transient-флага восстановления — тост только на первом
  // маунте формы после запуска (перезапуск приложения с несохранённым черновиком).
  useEffect(() => {
    if (useFormStore.getState().consumeDraftRestored()) {
      setDraftRestoredToast(true);
    }
  }, []);

  // Тост «Черновик восстановлен» скрывается сам (§10 — как «Сохранено»).
  useEffect(() => {
    if (!draftRestoredToast) {
      return undefined;
    }
    const timer = setTimeout(() => setDraftRestoredToast(false), SAVED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [draftRestoredToast]);

  // Тост-подсказка вставки скрывается сам (§10 — не блокирующий).
  useEffect(() => {
    if (!pasteFailedToast) {
      return undefined;
    }
    const timer = setTimeout(() => setPasteFailedToast(false), SAVED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [pasteFailedToast]);

  // TASK-032 §10: фокус в sys после закрытия диалога «Удалить и исправить» —
  // в эффекте (диалог уже размонтирован, восстановление фокуса Radix позади).
  useEffect(() => {
    if (!focusSysAfterClose || flagsDialog !== null) {
      return;
    }
    setFocusSysAfterClose(false);
    setActiveField('sys');
    sysRef.current?.focus();
  }, [focusSysAfterClose, flagsDialog]);

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
    // Успех (§10/§11): при флагах — модальный поток «Проверьте значения» (TASK-032 §5),
    // черновик и тост откладываются до решения; без флагов — как раньше: тост, сброс
    // чисел/заметки (рука/флаг остаются), флаги наверх.
    onSuccess: (result) => {
      if (hasFlags(result.flags)) {
        setFlagsDialog(result);
        return;
      }
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

  /**
   * TASK-032 §5/§10/§13: «Удалить и исправить» — канал measurements/delete, затем
   * возврат: значения остаются в форме (store не очищался), фокус в sys. Неуспех
   * НЕ_FOUND (§13) — тост «Запись уже удалена», форма пустая (нечему возвращаться);
   * иная ошибка (STORAGE/*) — запись на месте: значения остаются, тост.
   */
  const deleteMutation = useDeleteMeasurement({
    onSuccess: () => {
      setFlagsDialog(null);
      // §10: фокус в sys — после закрытия диалога (эффект ниже): Radix при закрытии
      // сам восстанавливает фокус и перебил бы прямой вызов.
      setFocusSysAfterClose(true);
    },
    onError: (error) => {
      setFlagsDialog(null);
      if (error.code === 'MEASUREMENT/NOT_FOUND') {
        // §13: запись уже удалена другим путём — возврат значений невозможен.
        resetAfterSave();
        setNowMs(Date.now());
        setSubmitAttempted(false);
      }
      setFocusSysAfterClose(true);
      showToast(error);
    },
  });

  /** «Оставить» (и Esc/оверлей — §16): запись остаётся, форма очищается, тост (§10). */
  const handleKeep = (): void => {
    setFlagsDialog(null);
    resetAfterSave();
    setNowMs(Date.now());
    setSubmitAttempted(false);
    setSaved(true);
  };

  /**
   * TASK-038 §5/§13: успех правки — возврат к режиму add (cancelEdit: editingId
   * в null, поля к дефолтам); владелец закрывает вид — тост «Правка применена»
   * и фокус-возврат в строку решает экран (§16).
   */
  const updateMutation = useUpdateMeasurement({
    onSuccess: () => {
      const editedId = useFormStore.getState().editingId;
      useFormStore.getState().cancelEdit();
      setNowMs(Date.now());
      setSubmitAttempted(false);
      if (editedId !== null) {
        onEditSuccess?.(editedId);
      }
    },
    // §13: NOT_FOUND — запись уже удалена другим путём: тост «Запись уже удалена»,
    // форма сбрасывается (cancelEdit), владелец закрывает вид; иная ошибка —
    // значения в форме остаются (правка не потеряна), тост.
    onError: (error) => {
      showToast(error);
      if (error.code === 'MEASUREMENT/NOT_FOUND') {
        useFormStore.getState().cancelEdit();
        setNowMs(Date.now());
        setSubmitAttempted(false);
        onCancel?.();
      }
    },
  });

  /**
   * TASK-038 §22: закрытие без сохранения — сброс правки к режиму add и закрытие
   * вида владельцем. В режиме add черновик store не трогается (переживает
   * закрытие формы — семантика TASK-039).
   */
  const finishCancel = (): void => {
    setDiscardOpen(false);
    if (useFormStore.getState().editingId !== null) {
      useFormStore.getState().cancelEdit();
    }
    onCancel?.();
  };

  /** Отмена (Esc/«Отмена», §5/§22): dirty-правка защищена подтверждением. */
  const handleCancel = (): void => {
    const draft = useFormStore.getState();
    if (draft.editingId !== null && isEditDirty(draft)) {
      setDiscardOpen(true);
      return;
    }
    finishCancel();
  };

  /** «Удалить и исправить» (§5): delete созданной записи — возврат решит мутация. */
  const handleDeleteFix = (): void => {
    if (flagsDialog === null || deleteMutation.isPending) {
      return;
    }
    deleteMutation.mutate({ id: flagsDialog.measurement.id });
  };

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

  /**
   * TASK-040 §5/§10/§13/§14: вставка из буфера в поле давления — перехват до
   * штатной вставки. Пара «120/80» (разделитель / , ; - и пробелы) → оба поля
   * ОДНИМ setPressure (§12), фокус в pulse; одиночное число ≤3 цифр → штатная
   * вставка в текущее поле (штатные действия набора: очистить + цифры); иначе
   * (мусор / 2+ числа >3 цифр) — тост-подсказка, содержимое полей НЕ изменено
   * (EC-18), фокус не уходит (§16). Пустой буфер — тихий no-op. Текст буфера
   * парсится в памяти, в DOM/логи не попадает (§14).
   */
  const handlePaste = (field: PasteField, event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text');
    const pair = parseBpPair(text);
    if (pair !== undefined) {
      event.preventDefault();
      setPressure(String(pair.sys), String(pair.dia));
      setActiveField('pulse');
      pulseRef.current?.focus();
      return;
    }
    const single = SINGLE_NUMBER_RE.exec(text);
    if (single !== null) {
      event.preventDefault();
      const digits = single[1];
      if (digits === undefined) {
        return;
      }
      clearField(field);
      for (const digit of digits) {
        appendDigit(field, digit);
      }
      return;
    }
    if (text.trim() !== '') {
      event.preventDefault();
      setPasteFailedToast(true);
    }
  };

  /**
   * Submit (§13): takenAt на момент submit; invalid — показать required-ошибки.
   * TASK-038 §5: в режиме edit (editingId из store) — submit → update с тем же
   * черновиком (§4: одна точка валидации — assembleUpdateRequest поверх add).
   */
  const submit = (): void => {
    const draft = useFormStore.getState();
    const draftInput = {
      sys: draft.sys,
      dia: draft.dia,
      pulse: draft.pulse,
      irregular: draft.irregular,
      arm: draft.arm,
      note: draft.note,
      when: draft.when,
    };
    const editingIdNow = draft.editingId;
    // Ветвь правки отдельно от add — точные типы запросов (MeasurementUpdateRequest).
    if (editingIdNow !== null) {
      const update = assembleUpdateRequest(draftInput, editingIdNow, Date.now());
      if (!update.ok) {
        setSubmitAttempted(true);
        return;
      }
      updateMutation.mutate(update.request);
      return;
    }
    const add = assembleAddRequest(draftInput, Date.now());
    if (!add.ok) {
      setSubmitAttempted(true);
      return;
    }
    mutation.mutate(add.request);
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
          onPaste={field === 'pulse' ? undefined : (event) => handlePaste(field, event)}
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
    <section
      data-testid="measurement-form"
      className="flex flex-col gap-4 p-4"
      onKeyDown={(event) => {
        // TASK-038 §5/§16: Esc = отмена (возврат к режиму add без изменений);
        // открытые диалоги обрабатывают Esc сами (Radix) — сюда не доходит.
        if (event.key !== 'Escape' || discardOpen || flagsDialog !== null) {
          return;
        }
        event.preventDefault();
        handleCancel();
      }}
    >
      {/* TASK-038 §10: в режиме edit заголовок «Изменение записи» вместо подсказки. */}
      {editingId === null ? (
        /* FR-9.2: обучающая подсказка над формой (§10). */
        <p className="text-sm text-accent">{t('measurement.form.hint')}</p>
      ) : (
        <h2 data-testid="form-title" className="text-lg font-semibold text-text">
          {t('measurement.form.editTitle')}
        </h2>
      )}

      {/* Мгновенное подтверждение (§10): role="status" — polite для скринридера. */}
      {saved && (
        <div role="status" data-testid="saved-toast" className="text-base font-semibold">
          {t('measurement.form.savedToast')}
        </div>
      )}

      {/* TASK-039 §5/§16: восстановление черновика после краша — polite-статус. */}
      {draftRestoredToast && (
        <div role="status" data-testid="draft-restored-toast" className="text-base font-semibold">
          {t('measurement.form.draftRestored')}
        </div>
      )}

      {/* TASK-040 §5/§16: подсказка при нераспознанной вставке — polite-статус. */}
      {pasteFailedToast && (
        <div role="status" data-testid="paste-failed-toast" className="text-base font-semibold">
          {t('measurement.form.pasteFailed')}
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

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!isValid || mutation.isPending || updateMutation.isPending}
            className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:opacity-50"
          >
            {mutation.isPending || updateMutation.isPending
              ? t('measurement.form.saving')
              : t('measurement.form.save')}
          </button>
          {/* TASK-038 §5: «Отмена» — возврат к режиму add без изменений (§22 барьер). */}
          <button
            type="button"
            onClick={handleCancel}
            className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
          >
            {t('measurement.form.cancel')}
          </button>
          {/*
            TASK-039 §5/§16/§20: явная очистка черновика — та же семантика, что
            resetAfterSave (числа/заметка/when чистятся, рука/флаг — prefs —
            остаются); localStorage `hl.formDraft` очищается persist-слоем.
          */}
          <button
            type="button"
            aria-label={t('measurement.form.clear')}
            onClick={resetAfterSave}
            disabled={mutation.isPending || updateMutation.isPending}
            className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
          >
            {t('measurement.form.clear')}
          </button>
        </div>
      </form>

      {/* Клавиатура после формы: таб-порядок полей §16 не ломается. */}
      <DigitPad
        onDigit={(digit) => handleDigit(activeField, digit)}
        onBackspace={() => handleBackspace(activeField)}
        onClear={() => handleClear(activeField)}
      />

      {/* TASK-032 §5: модальный поток «Проверьте значения» при флагах ответа add. */}
      {flagsDialog !== null && (
        <ConfirmFlagsDialog
          open
          flags={flagsDialog.flags}
          onKeep={handleKeep}
          onDeleteFix={handleDeleteFix}
        />
      )}

      {/*
        TASK-038 §22: барьер потери правки — AlertDialog «Закрыть без сохранения?».
        Фокус при открытии — в безопасной «Отмене» (поведение AlertDialog, §16);
        Esc/оверлей = остаться (onOpenChange false → закрытие диалога без сброса).
      */}
      <AlertDialog.Root
        open={discardOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDiscardOpen(false);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
          <AlertDialog.Content
            data-testid="discard-edit-dialog"
            className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-6 shadow-lg"
          >
            <AlertDialog.Title className="text-lg font-semibold text-text">
              {t('measurement.form.discardTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p className="mt-3 text-base text-text">{t('measurement.form.discardBody')}</p>
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  data-testid="discard-cancel"
                  className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                >
                  {t('measurement.form.cancel')}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  data-testid="discard-confirm"
                  onClick={finishCancel}
                  className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg"
                >
                  {t('measurement.form.discardConfirm')}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
