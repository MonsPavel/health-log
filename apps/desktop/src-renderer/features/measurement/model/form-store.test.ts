/**
 * TASK-031 §12/§19: тест базового zustand-черновика формы (БЕЗ persist — объём
 * TASK-039, §5). Модель: числа — строки цифр (≤3, клавиатура 0–9), when —
 * 'now' | {date, time}; сброс после сохранения чистит числа/заметку/when,
 * рука и флаг остаются (§5: «очистка полей (рука/флаги остаются)»).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import { isEditDirty, useFormStore } from './form-store';

beforeEach(() => {
  useFormStore.getState().resetAll();
});

/** DTO правимой записи: Instant 2026-09-24 18:30 UTC @ +180 → настенная 21:30. */
function editDto(overrides: Partial<MeasurementDto> = {}): MeasurementDto {
  return {
    id: 'm-1',
    profileId: 'seed-profile-0001',
    sys: 125,
    dia: 82,
    pulse: 70,
    irregularPulse: true,
    arm: 'left',
    note: 'утром',
    takenAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    tzOffsetMin: 180,
    source: 'manual',
    createdAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    updatedAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    ...overrides,
  };
}

describe('form-store — начальное состояние (§12)', () => {
  it('числа пусты, рука right, флаг false, when «now»', () => {
    const s = useFormStore.getState();
    expect(s.sys).toBe('');
    expect(s.dia).toBe('');
    expect(s.pulse).toBe('');
    expect(s.irregular).toBe(false);
    expect(s.arm).toBe('right');
    expect(s.note).toBe('');
    expect(s.when).toBe('now');
  });
});

describe('form-store — числовые поля (§5: крупные кнопки 0–9/backspace/очистить)', () => {
  it('appendDigit набирает 125 по цифрам', () => {
    const s = useFormStore.getState();
    s.appendDigit('sys', '1');
    s.appendDigit('sys', '2');
    s.appendDigit('sys', '5');
    expect(useFormStore.getState().sys).toBe('125');
  });

  it('больше 3 цифр не набирается (эвристика авто-перехода §13)', () => {
    const s = useFormStore.getState();
    s.appendDigit('sys', '1');
    s.appendDigit('sys', '2');
    s.appendDigit('sys', '5');
    s.appendDigit('sys', '5');
    expect(useFormStore.getState().sys).toBe('125');
  });

  it('removeLastDigit убирает последнюю цифру, clearField чистит', () => {
    const s = useFormStore.getState();
    s.appendDigit('dia', '8');
    s.appendDigit('dia', '2');
    s.removeLastDigit('dia');
    expect(useFormStore.getState().dia).toBe('8');
    s.clearField('dia');
    expect(useFormStore.getState().dia).toBe('');
  });

  it('поля независимы друг от друга', () => {
    const s = useFormStore.getState();
    s.appendDigit('sys', '1');
    s.appendDigit('pulse', '7');
    expect(useFormStore.getState().sys).toBe('1');
    expect(useFormStore.getState().pulse).toBe('7');
    expect(useFormStore.getState().dia).toBe('');
  });
});

describe('form-store — рука и флаг (§20: рука по умолчанию = предыдущая)', () => {
  it('setArm меняет руку, setIrregular — флаг', () => {
    const s = useFormStore.getState();
    s.setArm('left');
    s.setIrregular(true);
    expect(useFormStore.getState().arm).toBe('left');
    expect(useFormStore.getState().irregular).toBe(true);
  });

  it('resetAfterSave: числа/заметка чистятся, when → «now», рука и флаг остаются (§5)', () => {
    const s = useFormStore.getState();
    s.appendDigit('sys', '1');
    s.appendDigit('dia', '8');
    s.appendDigit('pulse', '7');
    s.setNote('утром');
    s.setArm('left');
    s.setIrregular(true);
    s.setWhenManual('2026-09-24', '21:30');

    s.resetAfterSave();

    const after = useFormStore.getState();
    expect(after.sys).toBe('');
    expect(after.dia).toBe('');
    expect(after.pulse).toBe('');
    expect(after.note).toBe('');
    expect(after.when).toBe('now');
    expect(after.arm).toBe('left');
    expect(after.irregular).toBe(true);
  });

  it('рука сохраняется между открытиями формы (в пределах сессии, §19)', () => {
    useFormStore.getState().setArm('left');
    // Эмуляция нового открытия: новый селектор читает тот же модульный store.
    expect(useFormStore.getState().arm).toBe('left');
  });
});

describe('form-store — когда (§5: «сейчас» / правка и заднее число)', () => {
  it('setWhenManual хранит дату и время', () => {
    useFormStore.getState().setWhenManual('2026-09-24', '21:30');
    expect(useFormStore.getState().when).toEqual({ date: '2026-09-24', time: '21:30' });
  });

  it('setWhenNow возвращает режим «сейчас»', () => {
    useFormStore.getState().setWhenManual('2026-09-24', '21:30');
    useFormStore.getState().setWhenNow();
    expect(useFormStore.getState().when).toBe('now');
  });
});

describe('form-store — setNote (§5: textarea ≤500)', () => {
  it('сохраняет текст заметки', () => {
    useFormStore.getState().setNote('после прогулки');
    expect(useFormStore.getState().note).toBe('после прогулки');
  });
});

describe('form-store — режим edit (TASK-038 §4/§10/§12: editingId, startEdit, cancelEdit)', () => {
  it('начально: editingId null (режим add), dirty false', () => {
    const s = useFormStore.getState();
    expect(s.editingId).toBeNull();
    expect(s.editBase).toBeNull();
    expect(isEditDirty(useFormStore.getState())).toBe(false);
  });

  it('startEdit заполняет поля из DTO: числа-строки, пульс, флаг, рука, заметка (§10)', () => {
    useFormStore.getState().startEdit(editDto());

    const s = useFormStore.getState();
    expect(s.editingId).toBe('m-1');
    expect(s.sys).toBe('125');
    expect(s.dia).toBe('82');
    expect(s.pulse).toBe('70');
    expect(s.irregular).toBe(true);
    expect(s.arm).toBe('left');
    expect(s.note).toBe('утром');
  });

  it('startEdit: when — настенные дата/время из Instant-полей (utcMs+tzOffsetMin, §10)', () => {
    useFormStore.getState().startEdit(editDto());

    expect(useFormStore.getState().when).toEqual({ date: '2026-09-24', time: '21:30' });
  });

  it('startEdit: без пульса/заметки — пустые строки (optional поля DTO, §11)', () => {
    useFormStore.getState().startEdit(editDto({ pulse: undefined, note: undefined }));

    const s = useFormStore.getState();
    expect(s.pulse).toBe('');
    expect(s.note).toBe('');
  });

  it('снимок editBase — исходные значения записи для dirty-проверки (§22)', () => {
    useFormStore.getState().startEdit(editDto());

    expect(useFormStore.getState().editBase).toEqual({
      sys: '125',
      dia: '82',
      pulse: '70',
      irregular: true,
      arm: 'left',
      note: 'утром',
      when: { date: '2026-09-24', time: '21:30' },
    });
  });

  it('сразу после startEdit dirty false; правка значения → dirty true (§22)', () => {
    useFormStore.getState().startEdit(editDto());
    expect(isEditDirty(useFormStore.getState())).toBe(false);

    useFormStore.getState().appendDigit('sys', '7'); // 125 → 1257? нет — поле заполнено, игнор
    // Правка через очистку и ввод (реальный путь пользователя).
    useFormStore.getState().clearField('sys');
    expect(isEditDirty(useFormStore.getState())).toBe(true);

    useFormStore.getState().appendDigit('sys', '1');
    useFormStore.getState().appendDigit('sys', '2');
    useFormStore.getState().appendDigit('sys', '5');
    expect(isEditDirty(useFormStore.getState())).toBe(false); // вернули исходное значение
  });

  it('dirty учитывает заметку, when и флаги (§22)', () => {
    useFormStore.getState().startEdit(editDto());

    useFormStore.getState().setNote('вечером');
    expect(isEditDirty(useFormStore.getState())).toBe(true);

    useFormStore.getState().setNote('утром');
    useFormStore.getState().setIrregular(false);
    expect(isEditDirty(useFormStore.getState())).toBe(true);
  });

  it('cancelEdit: поля к дефолтам, editingId/editBase null; рука и флаг — сессионная память (§10)', () => {
    useFormStore.getState().startEdit(editDto());
    useFormStore.getState().appendDigit('sys', '9');

    useFormStore.getState().cancelEdit();

    const s = useFormStore.getState();
    expect(s.editingId).toBeNull();
    expect(s.editBase).toBeNull();
    expect(s.sys).toBe('');
    expect(s.dia).toBe('');
    expect(s.pulse).toBe('');
    expect(s.note).toBe('');
    expect(s.when).toBe('now');
    expect(isEditDirty(useFormStore.getState())).toBe(false);
    // Сессионная память (§5/§20 TASK-031: рука по умолчанию = предыдущая).
    expect(s.arm).toBe('left');
    expect(s.irregular).toBe(true);
  });

  it('cancelEdit в режиме add (без startEdit) — не трогает черновик add (TASK-039 §5: persist)', () => {
    useFormStore.getState().appendDigit('sys', '1');

    useFormStore.getState().cancelEdit();

    expect(useFormStore.getState().sys).toBe('1');
  });
});
