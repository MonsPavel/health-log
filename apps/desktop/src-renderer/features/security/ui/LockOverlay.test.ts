/**
 * TASK-095 §5/§13/§16/§19: DOM-тесты экрана блокировки (мок канала):
 *  - поле пароля (label + autocomplete="current-password"), фокус в поле при показе;
 *  - unlock happy → канал vault/unlock и колбэк разблокировки (§13);
 *  - неверный пароль → инлайн «Неверный пароль» + aria-invalid/describedby + фокус
 *    на поле (§16);
 *  - backoff → кнопка disabled с live-отсчётом «Подождите N с» (§13/§16);
 *  - начальный backoffSec из vault/status (перезапуск в окне, §12);
 *  - Esc ничего не делает — безопасного выхода нет (§16).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LockOverlay } from './LockOverlay';

import '../../../i18n';

type InvokeMock = ReturnType<typeof vi.fn>;

let invoke: InvokeMock;
let onUnlocked: () => void;

const OK = (data: unknown) => ({ v: 1, ok: true, data });
const FAIL = (code: string, messageKey: string, params?: Record<string, unknown>) => ({
  v: 1,
  ok: false,
  error: params === undefined ? { code, messageKey } : { code, messageKey, params },
});

/** Мост: отвечающий по каналам (статус + unlock). */
function mockHl(respond: (channel: string) => unknown): void {
  invoke = vi.fn((channel: string) => Promise.resolve(respond(channel)));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
}

const STATUS_LOCKED = { mode: 'passphrase', locked: true };

function renderOverlay(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(LockOverlay, { onUnlocked }), { wrapper });
}

beforeEach(() => {
  onUnlocked = vi.fn(() => undefined);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('LockOverlay — показ и разблокировка (TASK-095 §5/§13)', () => {
  it('заголовок, поле пароля (label, autocomplete), кнопка; фокус в поле при показе (§16)', async () => {
    mockHl(() => OK(STATUS_LOCKED));
    renderOverlay();

    expect(screen.getByRole('heading', { name: 'Приложение заблокировано' })).toBeDefined();
    const input = screen.getByLabelText('Пароль');
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('button', { name: 'Разблокировать' })).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('unlock happy: канал vault/unlock {pass} и колбэк разблокировки (§13)', async () => {
    mockHl((channel) => (channel === 'vault/status' ? OK(STATUS_LOCKED) : OK({ ok: true })));
    renderOverlay();
    const input = await screen.findByLabelText('Пароль');
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: 'пароль-095' } });
    fireEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('vault/unlock', { pass: 'пароль-095' });
  });

  it('Enter в поле отправляет форму (§5: Enter=unlock)', async () => {
    mockHl((channel) => (channel === 'vault/status' ? OK(STATUS_LOCKED) : OK({ ok: true })));
    renderOverlay();
    const input = await screen.findByLabelText('Пароль');

    fireEvent.change(input, { target: { value: 'пароль' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
  });

  it('неверный пароль → инлайн «Неверный пароль», aria-invalid/describedby, фокус на поле (§16)', async () => {
    mockHl((channel) =>
      channel === 'vault/status'
        ? OK(STATUS_LOCKED)
        : FAIL('VAULT/WRONG_PASSPHRASE', 'errors.VAULT_WRONG_PASSPHRASE'),
    );
    renderOverlay();
    const input = await screen.findByLabelText('Пароль');

    fireEvent.change(input, { target: { value: 'неверный' } });
    fireEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));

    const error = await screen.findByTestId('lock-error');
    expect(error.textContent).toBe('Неверный пароль');
    expect(error.getAttribute('role')).toBe('alert');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('lock-error');
    // Оверлей на месте — разблокировки не было.
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('Esc ничего не делает — нет безопасного действия (§16)', async () => {
    mockHl(() => OK(STATUS_LOCKED));
    renderOverlay();
    await screen.findByRole('heading', { name: 'Приложение заблокировано' });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.getByRole('heading', { name: 'Приложение заблокировано' })).toBeDefined();
  });
});

describe('LockOverlay — backoff-отсчёт (TASK-095 §13/§16)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('RATE_LIMITED → кнопка disabled «Подождите N с» с live-отсчётом; по истечении — снова активна', async () => {
    mockHl((channel) =>
      channel === 'vault/status'
        ? OK(STATUS_LOCKED)
        : FAIL('VAULT/RATE_LIMITED', 'errors.VAULT_RATE_LIMITED', { backoffSec: 3 }),
    );
    renderOverlay();
    // Фейковые таймеры: flush микрозадач загрузки, затем sync-запросы (RTL waitFor
    // не продвигает vi-таймеры — прецедент §10 useHlEvent).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const input = screen.getByLabelText('Пароль');

    fireEvent.change(input, { target: { value: 'неверный' } });
    fireEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // flush отказа → окно backoff
    });

    expect(screen.getByTestId('lock-wait').getAttribute('aria-live')).toBe('polite');
    const assertWaiting = (sec: number): void => {
      expect(screen.getByTestId('lock-wait').textContent).toBe(`Подождите ${sec} с`);
      const button = screen.getByRole('button', { name: `Подождите ${sec} с` });
      expect(button.hasAttribute('disabled')).toBe(true);
    };
    assertWaiting(3);
    // Отсчёт тикает по секунде (эффект перепланирует таймер после каждого тика).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    assertWaiting(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    assertWaiting(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByTestId('lock-wait')).toBeNull();
    expect(screen.getByRole('button', { name: 'Разблокировать' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('перезапуск в окне backoff: начальный backoffSec из vault/status — сразу disabled (§12)', async () => {
    mockHl(() => OK({ ...STATUS_LOCKED, backoffSec: 2 }));
    renderOverlay();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole('heading', { name: 'Приложение заблокировано' })).toBeDefined();
    expect(screen.getByTestId('lock-wait').textContent).toBe('Подождите 2 с');
    expect(screen.getByRole('button', { name: 'Подождите 2 с' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
