/**
 * TASK-009 §19: юнит-тесты шины in-memory (Electron не нужен). Проверяются:
 * подписка/отписка, once, изоляция исключений подписчиков (§9: падение одного
 * обработчика не рвёт цепочку, ошибка — в лог-спае, §18 категория events),
 * порядок FIFO в рамках одного имени (§13).
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { HlEventMap } from '@hl/contracts';

import { createConsoleEventsLogger, EventBus, type EventsLogger } from './event-bus.js';

/** Логгер-спай: моки — standalone vi.fn (unbound-method, прецедент TASK-008). */
function fakeLogger(): { logger: EventsLogger; debug: Mock; error: Mock } {
  const debug = vi.fn();
  const error = vi.fn();
  return { logger: { debug, error }, debug, error };
}

describe('EventBus — подписка и доставка (§5)', () => {
  it('emit доставляет payload подписчику того же имени', () => {
    const bus = new EventBus(fakeLogger().logger);
    const handler = vi.fn();

    bus.on('measurement:changed', handler);
    bus.emit('measurement:changed', { profileId: 'p1' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ profileId: 'p1' });
  });

  it('подписчик другого имени не получает событие', () => {
    const bus = new EventBus(fakeLogger().logger);
    const handler = vi.fn();

    bus.on('app:log', handler);
    bus.emit('data:versionBumped', { newVersion: 2 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('off (и отписка-замыкание из on) убирает доставку', () => {
    const bus = new EventBus(fakeLogger().logger);
    const handler = vi.fn();

    const unsubscribe = bus.on('measurement:changed', handler);
    unsubscribe();
    bus.emit('measurement:changed', { profileId: 'p1' });

    bus.on('data:versionBumped', handler);
    bus.off('data:versionBumped', handler);
    bus.emit('data:versionBumped', { newVersion: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('emit без подписчиков — no-op без ошибок', () => {
    const { logger, error } = fakeLogger();
    const bus = new EventBus(logger);

    expect(() => bus.emit('measurement:changed', { profileId: 'p1' })).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('EventBus — once (§5)', () => {
  it('обработчик снимается после первой доставки', () => {
    const bus = new EventBus(fakeLogger().logger);
    const handler = vi.fn();

    bus.once('data:versionBumped', handler);
    bus.emit('data:versionBumped', { newVersion: 1 });
    bus.emit('data:versionBumped', { newVersion: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ newVersion: 1 });
  });
});

describe('EventBus — изоляция исключений подписчиков (§9, §20)', () => {
  it('падение первого подписчика не мешает второму; ошибка — в лог-спае', () => {
    const { logger, error } = fakeLogger();
    const bus = new EventBus(logger);
    const boom = new Error('subscriber boom');
    const first = vi.fn(() => {
      throw boom;
    });
    const second = vi.fn();

    bus.on('app:log', first);
    bus.on('app:log', second);
    bus.emit('app:log', { level: 'info', messageKey: 'log.key' });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ level: 'info', messageKey: 'log.key' });
    expect(error).toHaveBeenCalledTimes(1);
    const [message, meta] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta['cause']).toBe(boom);
    expect(meta['name']).toBe('app:log');
    void message;
  });
});

describe('EventBus — порядок доставки (§13)', () => {
  it('FIFO в рамках одного имени: обработчики в порядке подписки, события — в порядке emit', () => {
    const bus = new EventBus(fakeLogger().logger);
    const calls: string[] = [];
    const seen: HlEventMap['measurement:changed'][] = [];

    bus.on('measurement:changed', () => {
      calls.push('handler-1');
    });
    bus.on('measurement:changed', () => {
      calls.push('handler-2');
    });
    bus.on('measurement:changed', (payload) => {
      seen.push(payload);
    });
    bus.emit('measurement:changed', { profileId: 'a' });
    bus.emit('measurement:changed', { profileId: 'b' });

    expect(calls).toEqual(['handler-1', 'handler-2', 'handler-1', 'handler-2']);
    expect(seen.map((payload) => payload.profileId)).toEqual(['a', 'b']);
  });
});

describe('createConsoleEventsLogger (§18)', () => {
  it('пишет с категорией events (префикс [events])', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = createConsoleEventsLogger();
      logger.debug('dbg', { a: 1 });
      logger.error('err', { b: 2 });

      expect(debugSpy).toHaveBeenCalledWith('[events]', 'dbg', { a: 1 });
      expect(errorSpy).toHaveBeenCalledWith('[events]', 'err', { b: 2 });
    } finally {
      debugSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
