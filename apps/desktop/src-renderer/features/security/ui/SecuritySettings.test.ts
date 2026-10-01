/**
 * TASK-095 §5/§13/§19/§20: DOM-тесты секции «Защита паролем» (мок каналов):
 *  - выключено → «Включить»: диалог (новый ×2) — БЕЗ чекбокса кнопка мертва (AC-1);
 *    предупреждение-текст golden содержит «невосстановим»; с чекбоксом — канал
 *    vault/set-passphrase {action:'set'} и переключение секции во «включено»;
 *  - включено → смена (старый+новый; неверный старый — инлайн §13), снять (старый);
 *  - автоблок: select 5/15/60/выкл → prefs/set {autoLockMin} (AC-5, prefs-канал);
 *  - пароль в состоянии формы и уходит только в канал (§14).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecuritySettings } from './SecuritySettings';

import '../../../i18n';

type InvokeMock = ReturnType<typeof vi.fn>;

let invoke: InvokeMock;

const OK = (data: unknown) => ({ v: 1, ok: true, data });
const FAIL = (code: string, messageKey: string) => ({ v: 1, ok: false, error: { code, messageKey } });

/** Состояние мока: режим защиты и порог автоблока (prefs — источник, §12). */
function makeHl(initialMode: 'none' | 'passphrase'): { setMode: (m: 'none' | 'passphrase') => void; setPassError: (code: string | null) => void } {
  let mode: 'none' | 'passphrase' = initialMode;
  let autoLockMin = 5;
  let passErrorCode: string | null = null;
  const prefs = () => ({
    theme: 'system',
    textScale: '100',
    dateFormat: 'auto',
    advancedMode: false,
    netConsents: { updatesCheck: false, modelsDownload: false },
    autoLockMin,
  });
  invoke = vi.fn((channel: string, payload: { patch?: { autoLockMin?: number } }) => {
    if (channel === 'prefs/get') {
      return Promise.resolve(OK(prefs()));
    }
    if (channel === 'prefs/set') {
      autoLockMin = payload.patch?.autoLockMin ?? autoLockMin;
      return Promise.resolve(OK(prefs()));
    }
    if (channel === 'vault/status') {
      return Promise.resolve(OK({ mode, locked: false }));
    }
    if (channel === 'vault/set-passphrase') {
      if (passErrorCode !== null) {
        const dto = FAIL(passErrorCode, `errors.${passErrorCode.replace('/', '_')}`);
        passErrorCode = null;
        return Promise.resolve(dto);
      }
      mode = 'action' in payload && payload.action === 'remove' ? 'none' : 'passphrase';
      return Promise.resolve(OK({ mode }));
    }
    return Promise.resolve(OK(null));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return {
    setMode: (next) => {
      mode = next;
    },
    setPassError: (code) => {
      passErrorCode = code;
    },
  };
}

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(SecuritySettings), { wrapper });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('SecuritySettings — выключено: включение пароля (TASK-095 §5/AC-1)', () => {
  it('mode=none: кнопка «Включить», диалога нет; предупреждение golden «невосстановим» в диалоге', async () => {
    makeHl('none');
    renderSection();

    expect(screen.getByRole('heading', { name: 'Защита паролем' })).toBeDefined();
    const enable = await screen.findByRole('button', { name: 'Включить' });
    expect(screen.queryByTestId('security-dialog')).toBeNull();

    fireEvent.click(enable);

    const dialog = await screen.findByTestId('security-dialog');
    expect(dialog.textContent).toContain('невосстановим');
    expect(
      screen.getByLabelText('Я понимаю, что без пароля данные не восстановить'),
    ).toBeDefined();
  });

  it('без чекбокса кнопка сохранения мертва; пароли не совпадают — инлайн-ошибка (AC-1)', async () => {
    makeHl('none');
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Включить' }));
    await screen.findByTestId('security-dialog');

    const submit = screen.getByTestId('security-dialog-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'пароль-095' } });
    fireEvent.change(screen.getByLabelText('Новый пароль (ещё раз)'), {
      target: { value: 'другой' },
    });
    fireEvent.click(screen.getByLabelText('Я понимаю, что без пароля данные не восстановить'));
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText('Пароли не совпадают')).toBeDefined();
    expect(invoke).not.toHaveBeenCalledWith('vault/set-passphrase', expect.anything());
  });

  it('с чекбоксом: канал set-passphrase {action:set}, диалог закрыт, секция «включено» (AC-1)', async () => {
    makeHl('none');
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Включить' }));
    await screen.findByTestId('security-dialog');

    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'пароль-095' } });
    fireEvent.change(screen.getByLabelText('Новый пароль (ещё раз)'), {
      target: { value: 'пароль-095' },
    });
    fireEvent.click(screen.getByLabelText('Я понимаю, что без пароля данные не восстановить'));
    fireEvent.click(screen.getByTestId('security-dialog-submit'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('vault/set-passphrase', {
        action: 'set',
        pass: 'пароль-095',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('security-dialog')).toBeNull());
    // Статус перечитан: секция отражает включённый режим (§12 — сервер-источник).
    expect(await screen.findByRole('button', { name: 'Сменить пароль' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Снять пароль' })).toBeDefined();
  });
});

describe('SecuritySettings — включено: смена/снятие/автоблок (TASK-095 §5/§13)', () => {
  it('смена пароля: неверный старый — инлайн, диалог открыт; верный — успех (§13/AC-4)', async () => {
    const hl = makeHl('passphrase');
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить пароль' }));
    await screen.findByTestId('security-dialog');

    fireEvent.change(screen.getByLabelText('Текущий пароль'), { target: { value: 'неверный' } });
    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'новый-095' } });
    hl.setPassError('VAULT/WRONG_PASSPHRASE');
    fireEvent.click(screen.getByTestId('security-dialog-submit'));

    expect(await screen.findByText('Неверный текущий пароль')).toBeDefined();
    expect(screen.getByTestId('security-dialog')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Текущий пароль'), { target: { value: 'верный' } });
    fireEvent.click(screen.getByTestId('security-dialog-submit'));

    await waitFor(() => expect(screen.queryByTestId('security-dialog')).toBeNull());
    expect(invoke).toHaveBeenLastCalledWith('vault/set-passphrase', {
      action: 'change',
      old: 'верный',
      new: 'новый-095',
    });
  });

  it('снятие пароля: канал remove {old} → секция возвращается к «Включить» (§5)', async () => {
    makeHl('passphrase');
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Снять пароль' }));
    await screen.findByTestId('security-dialog');

    fireEvent.change(screen.getByLabelText('Текущий пароль'), { target: { value: 'верный' } });
    fireEvent.click(screen.getByTestId('security-dialog-submit'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('vault/set-passphrase', {
        action: 'remove',
        old: 'верный',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Включить' })).toBeDefined();
  });

  it('автоблок: select отражает prefs.autoLockMin; смена → prefs/set {autoLockMin} (AC-5)', async () => {
    makeHl('passphrase');
    renderSection();

    const select = (await screen.findByLabelText('Автоблокировка')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('5'));

    fireEvent.change(select, { target: { value: '15' } });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { autoLockMin: 15 } }),
    );
  });
});
