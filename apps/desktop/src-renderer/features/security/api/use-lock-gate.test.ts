/**
 * TASK-095 §5/§12/§13/§15/§19: тест гейта блокировки — единый источник состояния
 * (vault/status с сервера) + мгновенные события lock:engaged/lock:required (§15:
 * оверлей без запроса при показе) и optimistic setUnlocked после успеха (§13:
 * оверлей исчезает сразу). Фазы: loading (статус ещё неизвестен — контент не
 * рендерим: §13 «данные скрыты даже в момент загрузки»), locked, open.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLockGate, useVaultStatus } from './use-lock-gate';

type InvokeMock = ReturnType<typeof vi.fn>;

let invoke: InvokeMock;
let listeners: Map<string, (payload: unknown) => void>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

/** Мост: статус по каналу; события lock:* — через captured-слушатели useHlEvent. */
function mockHl(statusData: unknown | Promise<unknown>): void {
  listeners = new Map();
  invoke = vi.fn((_channel: string, _payload: unknown) => Promise.resolve(OK(statusData)));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return () => undefined;
      }),
    },
  });
}

function renderGate(): ReturnType<typeof renderHook<ReturnType<typeof useLockGate>, unknown>> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useLockGate(), { wrapper });
}

function fire(name: string): void {
  act(() => {
    listeners.get(name)?.({});
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('useLockGate — фазы гейта (TASK-095 §5/§12/§13)', () => {
  it('старт passphrase+locked → phase locked (оверлей до любых данных, §13)', async () => {
    mockHl({ mode: 'passphrase', locked: true });
    const { result } = renderGate();

    expect(result.current.phase).toBe('loading'); // до ответа контент не рендерим
    await waitFor(() => expect(result.current.phase).toBe('locked'));
  });

  it('mode=none (unlocked) → phase open — оверлей не появляется (§24: откат)', async () => {
    mockHl({ mode: 'none', locked: false });
    const { result } = renderGate();

    await waitFor(() => expect(result.current.phase).toBe('open'));
  });

  it('статус недоступен (зависший invoke) → loading — контент скрыт (§14)', () => {
    mockHl(new Promise<never>(() => undefined));
    const { result } = renderGate();

    expect(result.current.phase).toBe('loading');
  });

  it('событие lock:engaged в открытой сессии → locked немедленно (§15: без запроса)', async () => {
    mockHl({ mode: 'passphrase', locked: false });
    const { result } = renderGate();
    await waitFor(() => expect(result.current.phase).toBe('open'));

    fire('lock:engaged');

    expect(result.current.phase).toBe('locked');
  });

  it('событие lock:required (старт заблокированным) → locked (§5)', async () => {
    mockHl(new Promise<never>(() => undefined));
    const { result } = renderGate();
    expect(result.current.phase).toBe('loading');

    fire('lock:required');

    expect(result.current.phase).toBe('locked');
  });

  it('setUnlocked → open немедленно (§13: оверлей исчезает, не дожидаясь refetch)', async () => {
    mockHl({ mode: 'passphrase', locked: true });
    const { result } = renderGate();
    await waitFor(() => expect(result.current.phase).toBe('locked'));

    act(() => {
      result.current.setUnlocked();
    });

    expect(result.current.phase).toBe('open');
  });
});

describe('useVaultStatus — общий ключ запроса (§12)', () => {
  it('возвращает документ статуса из канала vault/status', async () => {
    mockHl({ mode: 'passphrase', locked: true, backoffSec: 2 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useVaultStatus(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ mode: 'passphrase', locked: true, backoffSec: 2 });
    expect(invoke).toHaveBeenCalledWith('vault/status', {});
  });
});
