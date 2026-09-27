/**
 * TASK-031 §12: zustand-черновик формы ввода — базовый store БЕЗ persist
 * (persist-черновик — объём TASK-039, §5). Модульный store живёт в пределах
 * сессии окна: рука и флаг «неровный пульс» переживают открытие/закрытие формы
 * (§20: «рука по умолчанию = предыдущая, внутри сессии»).
 *
 * Числа — строки цифр ≤3 символов (клавиатура 0–9, backspace, очистить — §5):
 * граница 3 — эвристика авто-перехода (§13: 3 цифры → next; 2-значные значения
 * завершаются Enter/кнопкой). Числа НЕ парсятся в store — строка черновика
 * парсится на submit (валидация zod-схемой contracts — единая истина).
 *
 * Ре-рендер только затронутого поля (§15) — компоненты подписываются узкими
 * селекторами `useFormStore((s) => s.sys)`, а не всем состоянием.
 *
 * TASK-038 §4/§10/§12: режим правки управляется store-полем `editingId` (не URL).
 * `startEdit(dto)` заполняет поля из DTO (числа — строки цифр, when — настенные
 * дата/время из пары {takenAtUtcMs, tzOffsetMin} — запись хранит СВОЙ offset,
 * арх. 04 §2) и снимок `editBase` — база dirty-проверки §22 («потеря правки при
 * закрытии без сохранения»). `cancelEdit()` возвращает поля к дефолтам (рука и
 * флаг остаются — сессионная память, §5/§20 TASK-031); в режиме add — no-op
 * (черновик add переживает закрытие формы — семантика TASK-039).
 */
import type { MeasurementDto } from '@hl/contracts';
import { create } from 'zustand';

import { wallDateKey } from './wall-date';

/** Числовые поля формы. */
export type NumericField = 'sys' | 'dia' | 'pulse';

/** Рука измерения — зеркало ArmSchema contracts (TASK-028). */
export type Arm = 'left' | 'right';

/** Момент измерения: «сейчас» или правка {date, time} (input type=date/time, TD-11). */
export type When = 'now' | { readonly date: string; readonly time: string };

/** Максимум цифр числового поля (все границы домена ≤300 — трёх разрядов достаточно). */
const MAX_DIGITS = 3;

/** Миллисекунд в минуте (целочисленная арифметика настенных компонентов — §15). */
const MS_PER_MINUTE = 60_000;

/**
 * Снимок значений правимой записи на момент startEdit (§22): база dirty-проверки
 * «закрыть без сохранения?» — сравнение текущего черновика с исходными значениями.
 */
export interface EditSnapshot {
  /** СДА — строка цифр. */
  readonly sys: string;
  /** ДДА — строка цифр. */
  readonly dia: string;
  /** ЧСС — строка цифр ('' — поле опущено). */
  readonly pulse: string;
  /** Флаг «неровный пульс». */
  readonly irregular: boolean;
  /** Рука. */
  readonly arm: Arm;
  /** Заметка ('' — поле опущено). */
  readonly note: string;
  /** Момент записи — настенные дата/время. */
  readonly when: When;
}

/** Черновик формы без действий (состояние). */
export interface FormDraftState {
  /** СДА — строка цифр, '' до ввода. */
  sys: string;
  /** ДДА — строка цифр, '' до ввода. */
  dia: string;
  /** ЧСС — строка цифр, '' до ввода (опциональное поле). */
  pulse: string;
  /** Флаг «неровный пульс» — остаётся после сохранения (§5). */
  irregular: boolean;
  /** Рука — остаётся после сохранения (§5, §20). */
  arm: Arm;
  /** Заметка ≤500 символов (счётчик — NoteField). */
  note: string;
  /** «Сейчас» или заднее число {date, time}. */
  when: When;
  /** TASK-038 §4/§12: id правимой записи (режим edit) или null (режим add). */
  editingId: string | null;
  /** TASK-038 §22: снимок значений записи на момент startEdit (база dirty). */
  editBase: EditSnapshot | null;
}

/** Действия черновика (§12: «+ actions»; TASK-038: + startEdit/cancelEdit). */
export interface FormDraftActions {
  /** Дописать цифру в числовое поле (кнопка или клавиатура); >3 цифр игнорируется. */
  appendDigit: (field: NumericField, digit: string) => void;
  /** Удалить последнюю цифру (backspace). */
  removeLastDigit: (field: NumericField) => void;
  /** Очистить числовое поле (кнопка «очистить»). */
  clearField: (field: NumericField) => void;
  /** Сменить руку (сегмент-контрол); выбор запоминается до конца сессии. */
  setArm: (arm: Arm) => void;
  /** Поставить/снять флаг «неровный пульс». */
  setIrregular: (irregular: boolean) => void;
  /** Изменить заметку. */
  setNote: (note: string) => void;
  /** Вернуть режим «сейчас» — takenAt соберётся на submit (§13). */
  setWhenNow: () => void;
  /** Перейти к ручному вводу даты/времени (заднее число разрешено, §5). */
  setWhenManual: (date: string, time: string) => void;
  /** Сброс после сохранения: числа/заметка/when чистятся, рука и флаг остаются (§5). */
  resetAfterSave: () => void;
  /**
   * TASK-038 §10: открыть правку записи — поля заполняются из DTO (включая when:
   * настенная дата/время из {takenAtUtcMs, tzOffsetMin}), editingId/editBase ставятся.
   */
  startEdit: (measurement: MeasurementDto) => void;
  /**
   * TASK-038 §10: отмена правки — поля к дефолтам, editingId/editBase в null; рука
   * и флаг остаются (сессионная память §5/§20 TASK-031). В режиме add — no-op
   * (черновик add переживает закрытие формы — TASK-039 §5).
   */
  cancelEdit: () => void;
  /** Полный сброс к начальным значениям (изоляция тестов; продуктом не вызывается). */
  resetAll: () => void;
}

/** Начальный черновик (рука right — стартовое значение до первого выбора). */
const INITIAL_DRAFT: FormDraftState = {
  sys: '',
  dia: '',
  pulse: '',
  irregular: false,
  arm: 'right',
  note: '',
  when: 'now',
  editingId: null,
  editBase: null,
};

/** Кладёт цифру в строку поля с границей MAX_DIGITS (чистая функция). */
function appendToDigits(current: string, digit: string): string {
  if (!/^[0-9]$/.test(digit) || current.length >= MAX_DIGITS) {
    return current;
  }
  return current + digit;
}

/** Число DTO → строка цифр (undefined — optional поле → '', §11). */
function digitsOf(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Настенное время Instant — 'HH:MM' (UTC-компоненты сдвинутого момента, §13). */
function wallTimeKey(utcMs: number, tzOffsetMin: number): string {
  const date = new Date(utcMs + tzOffsetMin * MS_PER_MINUTE);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/** Снимок значений записи (§22) — строки цифр, настенная дата/время из Instant. */
function snapshotOf(measurement: MeasurementDto): EditSnapshot {
  return {
    sys: digitsOf(measurement.sys),
    dia: digitsOf(measurement.dia),
    pulse: digitsOf(measurement.pulse),
    irregular: measurement.irregularPulse,
    arm: measurement.arm,
    note: measurement.note ?? '',
    when: {
      date: wallDateKey({ utcMs: measurement.takenAtUtcMs, tzOffsetMin: measurement.tzOffsetMin }),
      time: wallTimeKey(measurement.takenAtUtcMs, measurement.tzOffsetMin),
    },
  };
}

/** Ключ when для сравнения (§22): 'now' или 'date time' — без объектной идентичности. */
function whenKey(when: When): string {
  return when === 'now' ? 'now' : `${when.date} ${when.time}`;
}

/**
 * TASK-038 §22: dirty ли правка — текущий черновик отличается от снимка startEdit.
 * В режиме add (editBase null) — false (guard только для правки существующей записи).
 */
export function isEditDirty(state: FormDraftState): boolean {
  const base = state.editBase;
  if (state.editingId === null || base === null) {
    return false;
  }
  return (
    state.sys !== base.sys ||
    state.dia !== base.dia ||
    state.pulse !== base.pulse ||
    state.irregular !== base.irregular ||
    state.arm !== base.arm ||
    state.note !== base.note ||
    whenKey(state.when) !== whenKey(base.when)
  );
}

/** Store черновика (модульный — одна форма на окно; §12). */
export const useFormStore = create<FormDraftState & FormDraftActions>()((set) => ({
  ...INITIAL_DRAFT,

  appendDigit: (field, digit) => set((state) => ({ [field]: appendToDigits(state[field], digit) })),

  removeLastDigit: (field) => set((state) => ({ [field]: state[field].slice(0, -1) })),

  clearField: (field) => set({ [field]: '' }),

  setArm: (arm) => set({ arm }),

  setIrregular: (irregular) => set({ irregular }),

  setNote: (note) => set({ note }),

  setWhenNow: () => set({ when: 'now' }),

  setWhenManual: (date, time) => set({ when: { date, time } }),

  resetAfterSave: () => set({ sys: '', dia: '', pulse: '', note: '', when: 'now' }),

  startEdit: (measurement) =>
    set(() => {
      const base = snapshotOf(measurement);
      return { ...base, editingId: measurement.id, editBase: base };
    }),

  cancelEdit: () =>
    set((state) =>
      state.editingId === null
        ? state
        : { sys: '', dia: '', pulse: '', note: '', when: 'now', editingId: null, editBase: null },
    ),

  resetAll: () => set({ ...INITIAL_DRAFT }),
}));
