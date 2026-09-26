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
 */
import { create } from 'zustand';

/** Числовые поля формы. */
export type NumericField = 'sys' | 'dia' | 'pulse';

/** Рука измерения — зеркало ArmSchema contracts (TASK-028). */
export type Arm = 'left' | 'right';

/** Момент измерения: «сейчас» или правка {date, time} (input type=date/time, TD-11). */
export type When = 'now' | { readonly date: string; readonly time: string };

/** Максимум цифр числового поля (все границы домена ≤300 — трёх разрядов достаточно). */
const MAX_DIGITS = 3;

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
}

/** Действия черновика (§12: «+ actions»). */
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
};

/** Кладёт цифру в строку поля с границей MAX_DIGITS (чистая функция). */
function appendToDigits(current: string, digit: string): string {
  if (!/^[0-9]$/.test(digit) || current.length >= MAX_DIGITS) {
    return current;
  }
  return current + digit;
}

/** Store черновика (модульный — одна форма на окно; §12). */
export const useFormStore = create<FormDraftState & FormDraftActions>()((set) => ({
  ...INITIAL_DRAFT,

  appendDigit: (field, digit) =>
    set((state) => ({ [field]: appendToDigits(state[field], digit) })),

  removeLastDigit: (field) => set((state) => ({ [field]: state[field].slice(0, -1) })),

  clearField: (field) => set({ [field]: '' }),

  setArm: (arm) => set({ arm }),

  setIrregular: (irregular) => set({ irregular }),

  setNote: (note) => set({ note }),

  setWhenNow: () => set({ when: 'now' }),

  setWhenManual: (date, time) => set({ when: { date, time } }),

  resetAfterSave: () => set({ sys: '', dia: '', pulse: '', note: '', when: 'now' }),

  resetAll: () => set({ ...INITIAL_DRAFT }),
}));
