/**
 * TASK-031 §10/§16/§19/§20: интеграционный тест формы — рендер полей, автофокус
 * sys, ввод цифрами (клики/клавиатура), авто-переход sys→dia→pulse, валидация
 * (49 → подсветка + текст с params, сохранение заблокировано), submit вызывает
 * invoke с собранным payload, тост успеха + зануление (рука/флаг остаются),
 * серверная ошибка → тост, будущая дата — клиентская ошибка без IPC,
 * Enter = сохранить, рука сохраняется между открытиями.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementAddResponse } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { useFormStore } from '../model/form-store';
import { MeasurementForm } from './MeasurementForm';

const OK_ENVELOPE = (response: MeasurementAddResponse) => ({ v: 1, ok: true, data: response });

const ADD_RESPONSE: MeasurementAddResponse = {
  measurement: {
    id: 'm-1',
    profileId: 'seed-profile-0001',
    sys: 125,
    dia: 82,
    irregularPulse: false,
    arm: 'right',
    takenAtUtcMs: Date.now(),
    tzOffsetMin: -new Date().getTimezoneOffset(),
    source: 'manual',
    createdAtUtcMs: Date.now(),
    updatedAtUtcMs: Date.now(),
  },
  flags: {},
};

let invoke: ReturnType<typeof vi.fn>;

function renderForm(
  props: { readonly onSuccess?: (result: MeasurementAddResponse) => void } = {},
): void {
  const queryClient = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(MeasurementForm, props)),
    ),
  );
}

beforeEach(() => {
  useFormStore.getState().resetAll();
  invoke = vi.fn().mockResolvedValue(OK_ENVELOPE(ADD_RESPONSE));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

function sysInput(): HTMLInputElement {
  return screen.getByTestId('input-sys');
}
function diaInput(): HTMLInputElement {
  return screen.getByTestId('input-dia');
}
function pulseInput(): HTMLInputElement {
  return screen.getByTestId('input-pulse');
}
function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Сохранить' });
}

describe('MeasurementForm — рендер и a11y (§5/§16)', () => {
  it('поля: давление (fieldset), пульс, неровный пульс, рука, заметка, когда, сохранить', () => {
    renderForm();

    expect(screen.getByRole('group', { name: 'Давление (мм рт. ст.)' })).toBeDefined();
    expect(screen.getByLabelText('Верхнее (СДА)')).toBeDefined();
    expect(screen.getByLabelText('Нижнее (ДДА)')).toBeDefined();
    expect(screen.getByLabelText('Пульс (ЧСС)')).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Неровный пульс' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Рука' })).toBeDefined();
    expect(screen.getByLabelText('Заметка')).toBeDefined();
    expect(screen.getByText('Когда измерено')).toBeDefined();
    expect(saveButton()).toBeDefined();
    // FR-9.2: учебная подсказка над формой.
    expect(screen.getByText(/Первое измерение/)).toBeDefined();
  });

  it('автофокус в sys при открытии (§5)', () => {
    renderForm();

    expect(document.activeElement).toBe(sysInput());
  });

  it('порядок табуляции: sys→dia→pulse→irregular→arm→note→save (§16)', () => {
    renderForm();

    const order = [
      sysInput(),
      diaInput(),
      pulseInput(),
      screen.getByRole('checkbox', { name: 'Неровный пульс' }),
      screen.getByRole('radio', { name: 'Правая' }),
      screen.getByLabelText('Заметка'),
      saveButton(),
    ];
    for (const element of order) {
      expect(element.getAttribute('tabindex')).toBeNull();
    }
  });
});

describe('MeasurementForm — ввод цифр (§5/§13)', () => {
  it('клики по цифрам набирают в активном поле (sys)', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));

    expect(sysInput().value).toBe('125');
  });

  it('авто-переход sys→dia по 3 цифрам, затем dia→pulse (§13)', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));
    expect(document.activeElement).toBe(diaInput());

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    // 2 цифры в dia — перехода нет (не угадываем, §13/§22).
    expect(document.activeElement).toBe(diaInput());

    // Фокус в pulse вручную (клик по полю) — активное поле меняется.
    fireEvent.focus(pulseInput());
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 7' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 0' }));

    expect(sysInput().value).toBe('125');
    expect(diaInput().value).toBe('82');
    expect(pulseInput().value).toBe('70');
  });

  it('клавиатура: цифры в focused поле, backspace удаляет (§19)', () => {
    renderForm();

    fireEvent.keyDown(sysInput(), { key: '1' });
    fireEvent.keyDown(sysInput(), { key: '2' });
    expect(sysInput().value).toBe('12');
    fireEvent.keyDown(sysInput(), { key: 'Backspace' });
    expect(sysInput().value).toBe('1');
  });

  it('backspace/очистить клавиатуры действуют на активное поле', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 9' }));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить последнюю цифру' }));
    expect(sysInput().value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 9' }));
    fireEvent.click(screen.getByRole('button', { name: 'Очистить поле' }));
    expect(sysInput().value).toBe('');
  });
});

describe('MeasurementForm — валидация (§13/§20)', () => {
  it('49 в sys → подсветка aria-invalid + текст «от 50 до 300», сохранение заблокировано', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 9' }));

    expect(sysInput().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Систолическое давление: от 50 до 300 мм рт. ст.')).toBeDefined();
    expect(saveButton().disabled).toBe(true);
  });

  it('пустая форма: ошибки required не видны до попытки, кнопка заблокирована', () => {
    renderForm();

    expect(screen.queryByText('Введите значение')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('sys ≤ dia → подсветка dia ключом sysLeDia (§13)', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 0' }));
    fireEvent.focus(diaInput());
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));

    expect(screen.getByText('Систолическое давление должно быть больше диастолического.')).toBeDefined();
  });
});

describe('MeasurementForm — сохранение (§10/§11/§20)', () => {
  function fillValid(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
  }

  it('submit вызывает invoke с собранным payload; onSuccess получает {measurement, flags}', async () => {
    const onSuccess = vi.fn();
    renderForm({ onSuccess });
    fillValid();

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, payload] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe('measurements/add');
    expect(payload).toMatchObject({
      profileId: 'seed-profile-0001',
      sys: 125,
      dia: 82,
      irregularPulse: false,
      arm: 'right',
    });
    const takenAt = payload.takenAt as { utcMs: number; tzOffsetMin: number };
    // takenAt — на момент submit (§13): свежий now и текущая зона устройства.
    expect(Math.abs(takenAt.utcMs - Date.now())).toBeLessThan(60_000);
    expect(takenAt.tzOffsetMin).toBe(-new Date().getTimezoneOffset());
    expect(onSuccess).toHaveBeenCalledWith(ADD_RESPONSE);
  });

  it('после сохранения: тост «Сохранено», числовые поля пусты, рука сохранена (§5/§20)', async () => {
    renderForm();
    fillValid();
    fireEvent.click(screen.getByRole('radio', { name: 'Левая' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Неровный пульс' }));

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByTestId('saved-toast')).toBeDefined());
    await waitFor(() => expect(sysInput().value).toBe(''));
    expect(diaInput().value).toBe('');
    expect(pulseInput().value).toBe('');
    expect((screen.getByRole('radio', { name: 'Левая' })).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Неровный пульс' })).checked).toBe(
      true,
    );
  });

  it('заметка попадает в payload; пустой пульс — поле опущено (§11)', async () => {
    renderForm();
    fillValid();
    fireEvent.focus(pulseInput());
    fireEvent.click(screen.getByRole('button', { name: 'Удалить последнюю цифру' })); // pulse пуст
    fireEvent.change(screen.getByLabelText('Заметка'), { target: { value: 'утром' } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const payload = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.note).toBe('утром');
    expect('pulse' in payload).toBe(false);
  });

  it('Enter в числовом поле сохраняет (§16/§20)', async () => {
    renderForm();
    fillValid();

    fireEvent.keyDown(diaInput(), { key: 'Enter' });

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sysInput().value).toBe(''));
  });

  it('серверная ошибка → тост с messageKey, поля НЕ очищены (§10)', async () => {
    invoke = vi.fn().mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: 'VALIDATION/FAILED', messageKey: 'errors.validation' },
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    renderForm();
    fillValid();

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(
        screen.getByText('Проверьте правильность заполнения полей и попробуйте ещё раз.'),
      ).toBeDefined(),
    );
    expect(sysInput().value).toBe('125');
  });

  it('рука сохраняется между открытиями формы (в пределах сессии, §19/§20)', () => {
    renderForm();
    fireEvent.click(screen.getByRole('radio', { name: 'Левая' }));
    cleanup();

    renderForm();

    expect((screen.getByRole('radio', { name: 'Левая' })).checked).toBe(true);
  });
});

describe('MeasurementForm — когда: заднее число и будущее (§5/§20)', () => {
  it('будущая дата → клиентская ошибка, сохранение заблокировано, invoke НЕ вызван (§20)', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2099-01-01' } });

    expect(screen.getByText('Время измерения не может быть в будущем.')).toBeDefined();
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(saveButton());
    expect(invoke).not.toHaveBeenCalled();
  });

  it('прошлая дата сохраняется (заднее число разрешено, §5)', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-09-24' } });
    fireEvent.change(screen.getByLabelText('Время'), { target: { value: '21:30' } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const payload = invoke.mock.calls[0][1] as {
      takenAt: { utcMs: number; tzOffsetMin: number };
    };
    const wall = new Date(
      payload.takenAt.utcMs + payload.takenAt.tzOffsetMin * 60_000,
    );
    expect([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()]).toEqual([
      2026, 9, 24,
    ]);
    expect([wall.getUTCHours(), wall.getUTCMinutes()]).toEqual([21, 30]);
  });
});
