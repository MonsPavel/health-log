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
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementAddResponse, MeasurementDto } from '@hl/contracts';

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
  props: {
    readonly onSuccess?: (result: MeasurementAddResponse) => void;
    readonly onEditSuccess?: (id: string) => void;
    readonly onCancel?: () => void;
  } = {},
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

    expect(
      screen.getByText('Систолическое давление должно быть больше диастолического.'),
    ).toBeDefined();
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
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Левая' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Неровный пульс' }).checked).toBe(
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
    const payload = (invoke.mock.calls[0] as [unknown, Record<string, unknown>])[1];
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

    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Левая' }).checked).toBe(true);
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
    const payload = (
      invoke.mock.calls[0] as [
        unknown,
        {
          takenAt: { utcMs: number; tzOffsetMin: number };
        },
      ]
    )[1];
    const wall = new Date(payload.takenAt.utcMs + payload.takenAt.tzOffsetMin * 60_000);
    expect([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()]).toEqual([
      2026, 9, 24,
    ]);
    expect([wall.getUTCHours(), wall.getUTCMinutes()]).toEqual([21, 30]);
  });
});

describe('MeasurementForm — быстрый путь §20.1 (механика ≤15 с клавиатурой / ≤20 с тапами)', () => {
  /**
   * §20.1 автоматизирует ТОЛЬКО механику (сам хронометраж — ручной критерий §24,
   * E2E в живом рантайме — TASK-035 §19): полный клавиатурный путь — как его
   * наберёт пользователь — автофокус sys, цифры с авто-переходом по 3, Tab к
   * пульсу, Enter = сохранить, очистка. user-event — настоящая навигация Tab
   * (fireEvent фокус не перемещает).
   */
  it('клавиатура: 125 → авто-переход → 82 → Tab → 70 → Enter = сохранено, поля пусты', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(document.activeElement).toBe(sysInput());
    await user.keyboard('125');
    expect(document.activeElement).toBe(diaInput());
    await user.keyboard('82');
    // 2 цифры — перехода нет (не угадываем, §13/§22).
    expect(document.activeElement).toBe(diaInput());

    await user.tab();
    expect(document.activeElement).toBe(pulseInput());
    await user.keyboard('70');

    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('saved-toast')).toBeDefined());
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = (invoke.mock.calls[0] as [unknown, Record<string, unknown>])[1];
    expect(payload).toMatchObject({ sys: 125, dia: 82, pulse: 70 });
    expect(sysInput().value).toBe('');
    expect(diaInput().value).toBe('');
    expect(pulseInput().value).toBe('');
  });

  it('тапы: цифры кликами по крупным кнопкам, поле пульса — тапом, «Сохранить» — кликом', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.focus(pulseInput());
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 7' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 0' }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByTestId('saved-toast')).toBeDefined());
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = (invoke.mock.calls[0] as [unknown, Record<string, unknown>])[1];
    expect(payload).toMatchObject({ sys: 125, dia: 82, pulse: 70 });
  });
});

describe('MeasurementForm — диалог подтверждений (TASK-032 §5/§10/§13/§20)', () => {
  /** Валидный ввод 125/82 (прецедент fillValid из «сохранение»; пределы describe). */
  function fillValid(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
  }

  /** Ответ add с флагом typo (§20.1: история ~128, ввели 258). */
  const TYPO_RESPONSE = (id: string): MeasurementAddResponse => ({
    measurement: { ...ADD_RESPONSE.measurement, id },
    flags: { duplicate: false, typo: { field: 'sys', median: 128, value: 258, deviation: 130 } },
  });

  /** Конверт успешного delete (§11: {deleted: true}). */
  const DELETE_OK_ENVELOPE = { v: 1, ok: true, data: { deleted: true } };

  /** invoke, маршрутизирующий по каналу: add → typo-ответ, delete → заданный конверт. */
  function mockAddTypoThenDelete(deleteEnvelope: unknown): void {
    invoke = vi.fn((channel: string) => {
      if (channel === 'measurements/add') {
        return Promise.resolve(OK_ENVELOPE(TYPO_RESPONSE('m-1')));
      }
      return Promise.resolve(deleteEnvelope);
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
  }

  it('флаг typo в ответе add → открыт диалог с подстановками; черновик НЕ очищен, тоста нет (§10)', async () => {
    mockAddTypoThenDelete(DELETE_OK_ENVELOPE);
    renderForm();
    fillValid();

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByTestId('confirm-flags-dialog')).toBeDefined());
    expect(screen.getByTestId('hint-typo').textContent).toContain('Обычно около 128');
    expect(screen.getByTestId('hint-typo').textContent).toContain('258');
    // §10: store черновика не очищался до подтверждения — значения на месте.
    expect(sysInput().value).toBe('125');
    expect(diaInput().value).toBe('82');
    expect(screen.queryByTestId('saved-toast')).toBeNull();
  });

  it('без флагов диалог не открывается — обычный путь сохранения (§5: откат — add без диалога)', async () => {
    renderForm();
    fillValid();

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByTestId('saved-toast')).toBeDefined());
    expect(screen.queryByTestId('confirm-flags-dialog')).toBeNull();
  });

  it('«Оставить» → measurements/delete НЕ вызван, поля очищены, тост «Сохранено» (§20.1)', async () => {
    mockAddTypoThenDelete(DELETE_OK_ENVELOPE);
    renderForm();
    fillValid();

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('confirm-flags-dialog')).toBeDefined());
    fireEvent.click(screen.getByTestId('dialog-keep'));

    await waitFor(() => expect(screen.getByTestId('saved-toast')).toBeDefined());
    expect(screen.queryByTestId('confirm-flags-dialog')).toBeNull();
    expect(sysInput().value).toBe('');
    expect(diaInput().value).toBe('');
    // §20.1: «Оставить» — запись остаётся: delete-канал не вызывался (1 invoke = add).
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke.mock.calls[0] as [string])[0]).toBe('measurements/add');
  });

  it('Esc → «Оставить»: delete не вызван, поля очищены (§16 — безопасное действие)', async () => {
    mockAddTypoThenDelete(DELETE_OK_ENVELOPE);
    renderForm();
    fillValid();

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('confirm-flags-dialog')).toBeDefined());
    fireEvent.keyDown(screen.getByTestId('confirm-flags-dialog'), { key: 'Escape' });

    await waitFor(() => expect(screen.getByTestId('saved-toast')).toBeDefined());
    expect(sysInput().value).toBe('');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('«Удалить и исправить» → invoke measurements/delete {id}; значения вернулись, фокус в sys (§10/§20.2)', async () => {
    mockAddTypoThenDelete(DELETE_OK_ENVELOPE);
    renderForm();
    fillValid();

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('confirm-flags-dialog')).toBeDefined());
    fireEvent.click(screen.getByTestId('dialog-delete-fix'));

    await waitFor(() => expect(screen.queryByTestId('confirm-flags-dialog')).toBeNull());
    const [deleteChannel, deletePayload] = invoke.mock.calls[1] as [string, { id: string }];
    expect(deleteChannel).toBe('measurements/delete');
    expect(deletePayload).toEqual({ id: 'm-1' });
    // §10: форма получила обратно введённые значения (store не очищался), фокус в sys.
    expect(sysInput().value).toBe('125');
    expect(diaInput().value).toBe('82');
    expect(document.activeElement).toBe(sysInput());
  });

  it('delete NOT_FOUND → тост «Запись уже удалена», форма пустая, без краша (§13/§20.5)', async () => {
    mockAddTypoThenDelete({
      v: 1,
      ok: false,
      error: { code: 'MEASUREMENT/NOT_FOUND', messageKey: 'errors.MEASUREMENT_NOT_FOUND' },
    });
    renderForm();
    fillValid();

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('confirm-flags-dialog')).toBeDefined());
    fireEvent.click(screen.getByTestId('dialog-delete-fix'));

    // §13: тост, форма НЕ возвращает значения (нечему — пустая форма).
    await waitFor(() => expect(screen.getByText('Запись уже удалена')).toBeDefined());
    await waitFor(() => expect(screen.queryByTestId('confirm-flags-dialog')).toBeNull());
    expect(sysInput().value).toBe('');
    expect(diaInput().value).toBe('');
  });
});

describe('MeasurementForm — режим edit (TASK-038 §5/§10/§19/§20)', () => {
  /** Смещение устройства теста (машинонезависимо, прецедент HistoryScreen.test). */
  const TZ = -new Date().getTimezoneOffset();
  /** Запись с настенным временем 2026-09-24 21:30 в поясе устройства. */
  const EDIT_DTO: MeasurementDto = {
    id: 'm-1',
    profileId: 'seed-profile-0001',
    sys: 125,
    dia: 82,
    pulse: 70,
    irregularPulse: true,
    arm: 'left',
    note: 'утром',
    takenAtUtcMs: Date.UTC(2026, 8, 24, 21, 30) - TZ * 60_000,
    tzOffsetMin: TZ,
    source: 'manual',
    createdAtUtcMs: Date.UTC(2026, 8, 24, 21, 30) - TZ * 60_000,
    updatedAtUtcMs: Date.UTC(2026, 8, 24, 21, 30) - TZ * 60_000,
  };
  /** Конверт успешного update (§11: ответ {measurement}). */
  const UPDATE_OK = { v: 1, ok: true, data: { measurement: EDIT_DTO } };

  function startEditDto(): void {
    useFormStore.getState().startEdit(EDIT_DTO);
  }

  function editTitle(): HTMLElement {
    return screen.getByTestId('form-title');
  }

  it('форма предзаполнена из DTO: числа, пульс, флаг, рука, заметка, дата/время; заголовок editTitle (§10)', () => {
    startEditDto();
    renderForm();

    expect(editTitle().textContent).toBe('Изменение записи');
    expect(screen.queryByText(/Первое измерение/u)).toBeNull();
    expect(sysInput().value).toBe('125');
    expect(diaInput().value).toBe('82');
    expect(pulseInput().value).toBe('70');
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Неровный пульс' }).checked,
    ).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Левая' }).checked).toBe(true);
    expect((screen.getByLabelText('Заметка') as HTMLTextAreaElement).value).toBe('утром');
    expect((screen.getByLabelText('Дата') as HTMLInputElement).value).toBe('2026-09-24');
    expect((screen.getByLabelText('Время') as HTMLInputElement).value).toBe('21:30');
  });

  it('режим add: заголовок-подсказка без editTitle (§10)', () => {
    renderForm();

    expect(screen.queryByTestId('form-title')).toBeNull();
    expect(screen.getByText(/Первое измерение/u)).toBeDefined();
  });

  it('правка 125→127: submit вызывает measurements/update с id и новыми значениями (§20 AC1)', async () => {
    const onEditSuccess = vi.fn();
    invoke = vi.fn().mockResolvedValue(UPDATE_OK);
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    startEditDto();
    renderForm({ onEditSuccess });

    // 125 → 127: очистить sys (фокус уже в sys), ввести 127.
    fireEvent.click(screen.getByRole('button', { name: 'Очистить поле' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 7' }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(onEditSuccess).toHaveBeenCalledWith('m-1'));
    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, payload] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe('measurements/update');
    expect(payload).toMatchObject({ id: 'm-1', sys: 127, dia: 82, pulse: 70 });
    // Настенное время записи сохранено (правка 125→127 не двигала момент, §20 AC1).
    const takenAt = payload.takenAt as { utcMs: number; tzOffsetMin: number };
    const wall = new Date(takenAt.utcMs + takenAt.tzOffsetMin * 60_000);
    expect([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()]).toEqual([
      2026, 9, 24,
    ]);
    expect([wall.getUTCHours(), wall.getUTCMinutes()]).toEqual([21, 30]);
  });

  it('после успешной правки: editingId null, поля сброшены (возврат к режиму add, §5)', async () => {
    invoke = vi.fn().mockResolvedValue(UPDATE_OK);
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    startEditDto();
    renderForm({ onEditSuccess: () => undefined });

    fireEvent.click(saveButton());

    await waitFor(() => expect(useFormStore.getState().editingId).toBeNull());
    expect(useFormStore.getState().sys).toBe('');
    expect(useFormStore.getState().note).toBe('');
  });

  it('Esc в чистой правке: onCancel вызван, editingId null, запись не изменялась (§5/§20 AC2)', () => {
    const onCancel = vi.fn();
    startEditDto();
    renderForm({ onCancel });

    fireEvent.keyDown(screen.getByTestId('measurement-form'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(useFormStore.getState().editingId).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Esc при dirty → диалог «Закрыть без сохранения?»; «Отмена» — правка продолжается (§22)', async () => {
    const onCancel = vi.fn();
    startEditDto();
    renderForm({ onCancel });

    fireEvent.change(screen.getByLabelText('Заметка'), { target: { value: 'вечером' } });
    fireEvent.keyDown(screen.getByTestId('measurement-form'), { key: 'Escape' });

    const dialog = screen.getByTestId('discard-edit-dialog');
    expect(dialog.textContent).toContain('Закрыть без сохранения');
    expect(onCancel).not.toHaveBeenCalled();
    expect(useFormStore.getState().editingId).toBe('m-1');

    // «Отмена» в диалоге — форма остаётся открытой со значениями (§22).
    fireEvent.click(screen.getByTestId('discard-cancel'));
    await waitFor(() => expect(screen.queryByTestId('discard-edit-dialog')).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();
    expect(useFormStore.getState().editingId).toBe('m-1');
    expect((screen.getByLabelText('Заметка') as HTMLTextAreaElement).value).toBe('вечером');
  });

  it('Esc при dirty → «Закрыть без сохранения»: onCancel, editingId null (§22)', async () => {
    const onCancel = vi.fn();
    startEditDto();
    renderForm({ onCancel });

    fireEvent.change(screen.getByLabelText('Заметка'), { target: { value: 'вечером' } });
    fireEvent.keyDown(screen.getByTestId('measurement-form'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('discard-confirm'));

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(useFormStore.getState().editingId).toBeNull();
    expect(useFormStore.getState().note).toBe('');
  });

  it('«Отмена» в чистой правке закрывает форму без диалога (§5)', () => {
    const onCancel = vi.fn();
    startEditDto();
    renderForm({ onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(useFormStore.getState().editingId).toBeNull();
    expect(screen.queryByTestId('discard-edit-dialog')).toBeNull();
  });

  it('update NOT_FOUND → тост «Запись уже удалена», onCancel, форма сброшена (§13)', async () => {
    const onCancel = vi.fn();
    invoke = vi.fn().mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: 'MEASUREMENT/NOT_FOUND', messageKey: 'errors.MEASUREMENT_NOT_FOUND' },
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    startEditDto();
    renderForm({ onCancel });

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText('Запись уже удалена')).toBeDefined());
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(useFormStore.getState().editingId).toBeNull();
    expect(useFormStore.getState().sys).toBe('');
  });

  it('будущее время при правке: ошибка FUTURE_TIME, сохранение заблокировано, значения на месте (§20 AC4)', () => {
    startEditDto();
    renderForm();

    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2099-01-01' } });

    // Тот же текст каталога, что у тоста FUTURE_TIME; форма открыта, значения не тронуты.
    expect(screen.getByText('Время измерения не может быть в будущем.')).toBeDefined();
    expect(saveButton().disabled).toBe(true);
    expect(sysInput().value).toBe('125');
    expect(diaInput().value).toBe('82');

    fireEvent.click(saveButton());
    expect(invoke).not.toHaveBeenCalled();
  });
});
