/**
 * TASK-031 §12: zustand-черновик формы ввода. Модульный store живёт в пределах
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
 * флаг остаются — сессионная память, §5/§20 TASK-031); в режиме add — no-op.
 *
 * TASK-039 §5/§12: persist черновика (NFR-3 — ввод переживает краш) — ОДИН слой
 * zustand persist, чей storage-адаптер раскладывает срез по ДВУМ ключам
 * localStorage (единая гидрация — см. createDraftPrefsStorage):
 * - `hl.formDraft` (version 1): sys/dia/pulse/note/when — черновик; очищается
 *   после успешного сохранения (resetAfterSave в onSuccess ДО тоста — §13-1),
 *   кнопкой «Очистить» (та же семантика) и cancelEdit (режим edit);
 * - `hl.formPrefs` (version 1): arm/irregular — предпочтения (§20 РЕШЕНИЕ:
 *   «рука/флаги — настройки, НЕ черновик»), НЕ очищаются при сохранении.
 *
 * ОСОЗНАННОЕ ИСКЛЮЧЕНИЕ из политики TASK-013 §14 «никаких данных пользователя
 * в localStorage» (§4 TASK-039): черновик ввода — временное UI-состояние,
 * эквивалентное незакрытой форме; данные уже на локальной машине пользователя,
 * в резервные копии/экспорт localStorage не входит (§14). Альтернатива — БД через
 * IPC — асинхронна и ломает синхронное восстановление до первого рендера (§12).
 *
 * ЧЕСТНЫЙ ОСТАТОЧНЫЙ РИСК (§13-1/§22): краш между успешным сохранением на бэкенде
 * и очисткой store в onSuccess мог бы восстановить уже сохранённый черновик —
 * окно узкое (порядок кода: resetAfterSave() вызывается до тоста), дубликат
 * перехватывает флаг duplicate (TASK-032), риск принят осознанно.
 *
 * Повреждённый JSON → getItem возвращает null → дефолты без креша (§13-3,
 * try/catch в storage-адаптере). Режим edit черновик НЕ пишет (partialize — AC5):
 * значения правки всегда в БД, а сохранённый add-черновик к моменту startEdit
 * уже вытеснен из памяти самим startEdit (семантика TASK-038).
 */
import type { MeasurementDto } from '@hl/contracts';
import { create, type StateCreator } from 'zustand';
import {
  persist,
  type PersistOptions,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware';

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
  /**
   * TASK-039 §5: transient — при гидрации восстановлен НЕпустой черновик
   * (тост «Черновик восстановлен» один раз на запуск; не персистится).
   */
  draftRestored: boolean;
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
  /**
   * TASK-039 §5: transient — пометить «гидрация восстановила непустой черновик»
   * (вызывается onRehydrateStorage; тост восстановления один раз на запуск).
   */
  markDraftRestored: () => void;
  /**
   * TASK-039 §5/§16: прочитать и снять флаг восстановления — форма показывает
   * тост только на первом маунте после запуска.
   */
  consumeDraftRestored: () => boolean;
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
  draftRestored: false,
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

/** Полное состояние store черновика. */
type FormStoreState = FormDraftState & FormDraftActions;

/**
 * Инициализатор состояния и действий (§12) — общий для persist-слоёв. Каждый set
 * пишется в ОБА ключа persist (каждый слой сохраняет свой partialize-срез).
 */
const draftStore: StateCreator<FormStoreState, [], [], FormStoreState> = (set, get) => ({
  ...INITIAL_DRAFT,

  appendDigit: (field, digit) => set((state) => ({ [field]: appendToDigits(state[field], digit) })),

  removeLastDigit: (field) => set((state) => ({ [field]: state[field].slice(0, -1) })),

  clearField: (field) => set({ [field]: '' }),

  setArm: (arm) => set({ arm }),

  setIrregular: (irregular) => set({ irregular }),

  setNote: (note) => set({ note }),

  setWhenNow: () => set({ when: 'now' }),

  setWhenManual: (date, time) => set({ when: { date, time } }),

  /** Сброс после сохранения / кнопка «Очистить»: черновик пуст, prefs остаются (§5, AC2/AC3). */
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

  markDraftRestored: () => set({ draftRestored: true }),

  consumeDraftRestored: () => {
    const was = get().draftRestored;
    if (was) {
      set({ draftRestored: false });
    }
    return was;
  },

  resetAll: () => set({ ...INITIAL_DRAFT }),
});

/**
 * TASK-039 §13-3: envelope-чтение с явным try/catch — повреждённый JSON трактуется
 * как отсутствие значения (→ дефолты, без креша); не-объект тоже.
 */
function readEnvelope(key: string): { state?: unknown; version?: number } | null {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Envelope-запись: ошибка (квота/приватный режим) не роняет форму — черновик не драгоценен (§15). */
function writeEnvelope(key: string, state: unknown, version: number | undefined): void {
  try {
    localStorage.setItem(key, JSON.stringify({ state, version }));
  } catch {
    // Ввод продолжается в памяти, без креша.
  }
}

/**
 * TASK-039 §12/§13-3: storage-адаптер ОДНОГО persist-слоя, раскладывающий срез
 * `{draft, prefs}` по ДВУМ ключам localStorage — `hl.formDraft` и `hl.formPrefs`
 * (§20 РЕШЕНИЕ: рука/флаг — отдельный ключ, не очищается при сохранении).
 *
 * Почему ОДИН слой, а не два вложенных persist: гидрация внутреннего слоя идёт
 * первой и её set проходит через обёрнутый set внешнего — тот пишет свой ещё
 * негидратированный срез и затирает storage до чтения (гонка слоёв). Единая
 * гидрация читает оба ключа атомарно и мержит оба среза.
 *
 * Повреждённый JSON в любом из ключей → та часть = дефолты, вторая восстанавливается.
 * Нет localStorage (node-окружение) → undefined → persist отключается (прецедент
 * createJSONStorage).
 */
function createDraftPrefsStorage(): PersistStorage<PersistedSlice> | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }
  return {
    getItem: (draftKey): StorageValue<PersistedSlice> | null => {
      const draft = readEnvelope(draftKey);
      const prefs = readEnvelope(PREFS_KEY);
      if (draft === null && prefs === null) {
        return null;
      }
      return {
        state: {
          draft: draft?.state as PersistedDraft | undefined,
          prefs: prefs?.state as PersistedPrefs | undefined,
        },
        version: draft?.version ?? prefs?.version,
      };
    },
    setItem: (draftKey, value) => {
      writeEnvelope(draftKey, value.state.draft, value.version);
      writeEnvelope(PREFS_KEY, value.state.prefs, value.version);
    },
    removeItem: (draftKey) => {
      try {
        localStorage.removeItem(draftKey);
        localStorage.removeItem(PREFS_KEY);
      } catch {
        // Аналогично записи: не роняем форму.
      }
    },
  };
}

/**
 * Схема persist `hl.formDraft` (version 1, §5): только черновиковые поля.
 * Transient-поля (editingId/editBase/draftRestored) сюда не попадают никогда.
 */
export interface PersistedDraft {
  /** СДА — строка цифр. */
  readonly sys: string;
  /** ДДА — строка цифр. */
  readonly dia: string;
  /** ЧСС — строка цифр ('' — опущено). */
  readonly pulse: string;
  /** Заметка ('' — опущено). */
  readonly note: string;
  /** «Сейчас» или заднее число {date, time} (§13-2: строка сохраняется как введена). */
  readonly when: When;
}

/** Схема persist `hl.formPrefs` (version 1, §20 РЕШЕНИЕ): предпочтения формы. */
export interface PersistedPrefs {
  /** Рука — последняя выбранная (§20 TASK-031, переживает перезапуск). */
  readonly arm: Arm;
  /** Флаг «неровный пульс» — последнее состояние. */
  readonly irregular: boolean;
}

/**
 * Срез persist-слоя до раскладки адаптером: черновик → `hl.formDraft`,
 * предпочтения → `hl.formPrefs` (адаптер — createDraftPrefsStorage). Части
 * опциональны: из хранилища конверт может отсутствовать/быть повреждён —
 * merge/migrate сводят отсутствующие части к дефолтам.
 */
interface PersistedSlice {
  draft?: PersistedDraft;
  prefs?: PersistedPrefs;
}

/** Ключ persist предпочтений (ключ черновика — name слоя, `hl.formDraft`). */
const PREFS_KEY = 'hl.formPrefs';

/** Гвардия when: 'now' или {date, time} со строковыми компонентами. */
function isWhen(value: unknown): value is When {
  return (
    value === 'now' ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { date?: unknown }).date === 'string' &&
      typeof (value as { time?: unknown }).time === 'string')
  );
}

/**
 * Санитайзер persisted-черновика (merge + migrate v0→v1, §5/§13-3): только известные
 * поля, только строковые sys/dia/pulse/note и валидный when — незнакомые ключи и
 * неверные типы отбрасываются (в т.ч. случайные editingId из чужих рук — не
 * восстанавливаются).
 */
function sanitizeDraft(raw: unknown): PersistedDraft {
  const r = (raw ?? {}) as Partial<PersistedDraft>;
  return {
    sys: typeof r.sys === 'string' ? r.sys : '',
    dia: typeof r.dia === 'string' ? r.dia : '',
    pulse: typeof r.pulse === 'string' ? r.pulse : '',
    note: typeof r.note === 'string' ? r.note : '',
    when: isWhen(r.when) ? r.when : 'now',
  };
}

/** Санитайзер persisted-предпочтений (merge + migrate): только arm/irregular. */
function sanitizePrefs(raw: unknown): PersistedPrefs {
  const r = (raw ?? {}) as Partial<PersistedPrefs>;
  return {
    arm: r.arm === 'left' ? 'left' : 'right',
    irregular: r.irregular === true,
  };
}

/** Непуст ли черновик (тост восстановления — §5: «при непустом»). */
function hasDraftContent(
  state: Pick<FormDraftState, 'sys' | 'dia' | 'pulse' | 'note' | 'when'>,
): boolean {
  return (
    state.sys !== '' ||
    state.dia !== '' ||
    state.pulse !== '' ||
    state.note !== '' ||
    state.when !== 'now'
  );
}

/**
 * Опции persist-слоя (§5/§12): version 1 + migrate (v0→v1 — санитизация), merge —
 * только известные поля. В режиме edit (AC5) черновик НЕ пишется — partialize
 * отдаёт пустой срез (значения правки живут в БД; сохранённый add-черновик к
 * моменту startEdit уже вытеснен из памяти самим startEdit — семантика TASK-038).
 * При гидрации непустого черновика ставится transient-флаг draftRestored (тост
 * восстановления — один раз, consumeDraftRestored). Гидрация — при создании store
 * (localStorage синхронен, §12).
 */
const formPersistOptions: PersistOptions<FormStoreState, PersistedSlice> = {
  name: 'hl.formDraft',
  version: 1,
  storage: createDraftPrefsStorage(),
  partialize: (state) => ({
    draft:
      state.editingId === null
        ? { sys: state.sys, dia: state.dia, pulse: state.pulse, note: state.note, when: state.when }
        : { sys: '', dia: '', pulse: '', note: '', when: 'now' },
    prefs: { arm: state.arm, irregular: state.irregular },
  }),
  migrate: (persisted) => {
    const slice = (persisted ?? {}) as Partial<PersistedSlice>;
    return { draft: sanitizeDraft(slice.draft), prefs: sanitizePrefs(slice.prefs) };
  },
  merge: (persisted, current) => {
    if (persisted === null || persisted === undefined) {
      return current;
    }
    const slice = persisted as Partial<PersistedSlice>;
    return { ...current, ...sanitizeDraft(slice.draft), ...sanitizePrefs(slice.prefs) };
  },
  onRehydrateStorage: () => (state) => {
    if (state && hasDraftContent(state)) {
      state.markDraftRestored();
    }
  },
};

/** Store черновика (модульный — одна форма на окно; §12) с persist TASK-039. */
export const useFormStore = create<FormStoreState>()(persist(draftStore, formPersistOptions));
