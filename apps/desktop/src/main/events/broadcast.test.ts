/**
 * TASK-009 §19: тесты моста broadcast — fake webContents (spy send), Electron не нужен
 * (все зависимости — через BroadcastDeps). Проверяются критерии §20: доставка
 * {name, payload} обоим окнам по каналу hl:event; destroyed-окно не получает и не роняет
 * broadcast; отписка dead-окон (§5: isDestroyed при отправке + 'destroyed'-событие);
 * ошибка send глушится с логом debug (§9).
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { HL_EVENT_CHANNEL } from '@hl/contracts';

import { createBroadcastToWindows, type BroadcastDeps, type BroadcastTarget } from './broadcast.js';
import type { EventsLogger } from './event-bus.js';

// vi.mock хойстится выше импортов — broadcast.js транзитивно импортирует electron
// (реестр webContents); в юнит-тестах он не нужен (§19: mock electron, прецедент TASK-008).
vi.mock('electron', () => ({ webContents: { getAllWebContents: vi.fn(() => []) } }));

/** Fake webContents (§19): spy send, ручной вызов 'destroyed'-подписчиков. */
function fakeTarget(options: { destroyed?: boolean; sendThrows?: Error } = {}): {
  target: BroadcastTarget;
  send: Mock;
  destroy(): void;
} {
  const send = vi.fn(() => {
    if (options.sendThrows !== undefined) {
      throw options.sendThrows;
    }
  });
  const destroyedListeners: Array<() => void> = [];
  const target: BroadcastTarget = {
    isDestroyed: () => options.destroyed === true,
    send,
    once: (_event, listener) => {
      destroyedListeners.push(listener);
    },
  };
  return {
    target,
    send,
    destroy(): void {
      options.destroyed = true;
      for (const listener of destroyedListeners) {
        listener();
      }
    },
  };
}

function fakeDeps(targets: BroadcastTarget[]): {
  deps: BroadcastDeps;
  debug: Mock;
} {
  const debug = vi.fn();
  const logger: EventsLogger = { debug, error: vi.fn() };
  return { deps: { getAllTargets: () => targets, logger }, debug };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('broadcastToWindows — доставка (§20)', () => {
  it('emit в main → оба окна получили {name, payload} на канале hl:event', () => {
    const a = fakeTarget();
    const b = fakeTarget();
    const { deps } = fakeDeps([a.target, b.target]);
    const broadcast = createBroadcastToWindows(deps);

    broadcast('measurement:changed', { profileId: 'p1' });

    const envelope = { name: 'measurement:changed', payload: { profileId: 'p1' } };
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith(HL_EVENT_CHANNEL, envelope);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledWith(HL_EVENT_CHANNEL, envelope);
  });

  it('второй emit доходит после первого — FIFO в рамках имени (§13)', () => {
    const a = fakeTarget();
    const { deps } = fakeDeps([a.target]);
    const broadcast = createBroadcastToWindows(deps);

    broadcast('data:versionBumped', { newVersion: 1 });
    broadcast('data:versionBumped', { newVersion: 2 });

    expect(a.send.mock.calls.map(([, envelope]) => envelope)).toEqual([
      { name: 'data:versionBumped', payload: { newVersion: 1 } },
      { name: 'data:versionBumped', payload: { newVersion: 2 } },
    ]);
  });
});

describe('broadcastToWindows — dead-окна (§5, §20)', () => {
  it('destroyed-окно не получает событие, broadcast не падает', () => {
    const alive = fakeTarget();
    const dead = fakeTarget({ destroyed: true });
    const { deps } = fakeDeps([alive.target, dead.target]);
    const broadcast = createBroadcastToWindows(deps);

    expect(() => broadcast('app:log', { level: 'info', messageKey: 'k' })).not.toThrow();
    expect(dead.send).not.toHaveBeenCalled();
    expect(alive.send).toHaveBeenCalledTimes(1);
  });

  it("удаление по 'destroyed': окно, закрытое между broadcast'ами, больше не в рассылке", () => {
    const a = fakeTarget();
    const b = fakeTarget();
    const { deps } = fakeDeps([a.target, b.target]);
    const broadcast = createBroadcastToWindows(deps);

    broadcast('app:log', { level: 'info', messageKey: 'k' }); // оба подписаны на 'destroyed'
    b.destroy(); // закрытие окна → webContents destroyed
    broadcast('app:log', { level: 'info', messageKey: 'k' });

    expect(a.send).toHaveBeenCalledTimes(2);
    expect(b.send).toHaveBeenCalledTimes(1);
  });
});

describe('broadcastToWindows — ошибки send (§9: fire-and-forget)', () => {
  it('бросок send одного окна глушится с логом debug, остальные доставлены', () => {
    const failing = fakeTarget({ sendThrows: new Error('Object has been destroyed') });
    const healthy = fakeTarget();
    const { deps, debug } = fakeDeps([failing.target, healthy.target]);
    const broadcast = createBroadcastToWindows(deps);

    expect(() => broadcast('measurement:changed', { profileId: 'p1' })).not.toThrow();

    expect(healthy.send).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(1);
    const [message, meta] = debug.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta['name']).toBe('measurement:changed');
    expect((meta['cause'] as Error).message).toContain('Object has been destroyed');
    void message;
  });
});
