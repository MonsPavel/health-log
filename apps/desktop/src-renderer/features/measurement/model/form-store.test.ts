/**
 * TASK-031 §12/§19: тест базового zustand-черновика формы (БЕЗ persist — объём
 * TASK-039, §5). Модель: числа — строки цифр (≤3, клавиатура 0–9), when —
 * 'now' | {date, time}; сброс после сохранения чистит числа/заметку/when,
 * рука и флаг остаются (§5: «очистка полей (рука/флаги остаются)»).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useFormStore } from './form-store';

beforeEach(() => {
  useFormStore.getState().resetAll();
});

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
