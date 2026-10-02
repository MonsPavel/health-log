/**
 * TASK-095 §13/§14/§19/§20: интеграция гейта в корне App:
 *  - старт passphrase+locked → оверлей, а ДОМАШНИЙ КОНТЕНТ/навигация в DOM
 *    ОТСУТСТВУЮТ (§14 РЕШЕНИЕ: маршруты не рендерятся при locked — строже inert);
 *    запросов данных нет (§15);
 *  - mode=none → каркас как раньше (§24: откат — оверлей не появляется);
 *  - lock:engaged в открытой сессии → оверлей, контент выгружен (§5/§13).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

type InvokeMock = ReturnType<typeof vi.fn>;

let invoke: InvokeMock;
let listeners: Map<string, (payload: unknown) => void>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

/** Мост: vault/status — по сценарию; прочие чтения — пустые данные + счётчик каналов. */
function mockHl(statusData: unknown): void {
  listeners = new Map();
  invoke = vi.fn((channel: string) => {
    if (channel === 'vault/status') {
      return Promise.resolve(OK(statusData));
    }
    return Promise.resolve(OK(channel === 'prefs/get' ? null : { items: [], total: 0 }));
  });
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

describe('App — гейт блокировки (TASK-095 §13/§14/§20)', () => {
  it('старт passphrase+locked: оверлей в DOM; навигации/домашнего контента НЕТ; запросов данных нет (AC)', async () => {
    mockHl({ mode: 'passphrase', locked: true });

    render(createElement(App));

    expect(await screen.findByRole('heading', { name: 'Приложение заблокировано' })).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Разделы' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Сводка' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Настройки' })).toBeNull();
    // §15: показ оверлея — без запросов прикладных данных. prefs/get — каркасный
    // вызов провайдера темы (при locked отвечает гвардия VAULT/LOCKED — §7 094),
    // данных не приносит; vault/status — сам источник гейта; app/meta — источник
    // гейта восстановления TASK-101 §10 (версии/режим, НЕ secure — БД не читает);
    // heartbeat — сигнал.
    const dataChannels = invoke.mock.calls
      .map((call) => String(call[0]))
      .filter(
        (channel) =>
          channel !== 'vault/status' &&
          channel !== 'app/heartbeat' &&
          channel !== 'prefs/get' &&
          channel !== 'app/meta',
      );
    expect(dataChannels).toEqual([]);
  });

  it('mode=none: оверлея нет — каркас с навигацией как раньше (§24: откат)', async () => {
    mockHl({ mode: 'none', locked: false });

    render(createElement(App));

    expect(await screen.findByRole('navigation', { name: 'Разделы' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Приложение заблокировано' })).toBeNull();
  });

  it('lock:engaged в открытой сессии: оверлей появился, контент выгружен (§5/§13)', async () => {
    mockHl({ mode: 'passphrase', locked: false });

    render(createElement(App));
    expect(await screen.findByRole('navigation', { name: 'Разделы' })).toBeDefined();

    fire('lock:engaged');

    expect(await screen.findByRole('heading', { name: 'Приложение заблокировано' })).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Разделы' })).toBeNull();
    // §14: содержимое под оверлеем ВЫГРУЖЕНО — контента нет ни в одном узле дерева.
    expect(document.body.textContent).not.toContain('Сводка');
  });
});
