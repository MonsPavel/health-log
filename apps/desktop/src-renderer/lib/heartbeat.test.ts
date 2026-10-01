/**
 * TASK-095 §5/§19: тесты heartbeat — троттл 30 с (чистая фабрика: ведущий фронт —
 * активность шлёт канал не чаще раза в 30 с) и хук useHeartbeat (слушатели
 * pointerdown/keydown на window в capture-фазе; отписка при unmount; сбой канала
 * глушится — heartbeat не должен ронять UI, §9 прецедент logClientError).
 */
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_THROTTLE_MS, createHeartbeatSender, useHeartbeat } from './heartbeat';

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: null });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('createHeartbeatSender — троттл 30 с (§5)', () => {
  it('первая активность шлёт немедленно; повтор в окне 30 с — глушится', () => {
    let nowMs = 1_000;
    const send = vi.fn();
    const notify = createHeartbeatSender(send, () => nowMs);

    notify();
    notify();
    nowMs += HEARTBEAT_THROTTLE_MS - 1;
    notify();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('после истечения 30 с — шлёт снова (активность продлевает окно автоблока, §9)', () => {
    let nowMs = 1_000;
    const send = vi.fn();
    const notify = createHeartbeatSender(send, () => nowMs);

    notify();
    nowMs += HEARTBEAT_THROTTLE_MS;
    notify();
    nowMs += HEARTBEAT_THROTTLE_MS + 5_000;
    notify();

    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('useHeartbeat — слушатели активности (§5)', () => {
  it('pointerdown/keydown шлют app/heartbeat {}; троттл глушит всплеск', async () => {
    renderHook(() => useHeartbeat());

    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: 'A' });

    // Канал вызывается синхронно из обработчика (троттл — leading edge, §5).
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('app/heartbeat', {});

    // Всплеск в окне троттла — второй вызов не уходит.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_THROTTLE_MS - 1_000);
    });
    fireEvent.pointerDown(document.body);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Окно истекло — активность шлёт снова (продление окна автоблока).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    fireEvent.keyDown(document.body, { key: 'B' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('отписка при unmount: активность после размонтирования не шлёт канал (§10)', () => {
    const { unmount } = renderHook(() => useHeartbeat());
    unmount();

    fireEvent.pointerDown(document.body);

    expect(invoke).not.toHaveBeenCalled();
  });

  it('отказ канала глушится — UI не падает (§9, fire-and-forget)', async () => {
    invoke.mockRejectedValue(new Error('IPC недоступен'));
    renderHook(() => useHeartbeat());

    fireEvent.pointerDown(document.body);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('useHeartbeat — smoke рендера', () => {
  it('хук в компоненте не ломает дерево', () => {
    function Screen(): JSX.Element {
      useHeartbeat();
      return createElement('div', null, 'ok');
    }
    render(createElement(Screen));
    expect(document.body.textContent).toContain('ok');
  });
});
