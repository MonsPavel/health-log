/**
 * TASK-008 §19: интеграционный тест каркаса IPC — экспортируемая функция-обработчик
 * (registry.dispatch) тестируется напрямую, ipcMain mock-ается (in-memory harness).
 * Порядок обработки — §13: (1) канал существует → (2) payload валиден → (3) handler →
 * (4) неизвестное исключение. Наружу всегда конверт ApiEnvelope, исключения не проходят.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';

import {
  API_ENVELOPE_VERSION,
  APP_INTERNAL_ERROR,
  HL_INVOKE_CHANNEL,
  VALIDATION_FAILED_ERROR,
  type ApiEnvelope,
} from '@hl/contracts';
import { AppError } from '@hl/kernel';

import {
  createChannelRegistry,
  installChannelBridge,
  type ChannelRegistry,
  type IpcLogger,
} from './register-channel.js';

// vi.mock хойстится выше const-объявлений — сам мок создаётся в vi.hoisted (§19: mock ipcMain).
const ipcMainHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcMainHandle } }));

/** Схемы тестового канала: strict-объект с одним строковым полем. */
const echoSchemas = {
  request: z.object({ value: z.string() }).strict(),
  response: z.object({ value: z.string() }).strict(),
};

function fakeLogger(): { logger: IpcLogger; warn: Mock; error: Mock } {
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { warn, error }, warn, error };
}

function registryWithEchoHandler(
  logger: IpcLogger,
  handler: (payload: { value: string }) => { value: string },
): ChannelRegistry {
  const registry = createChannelRegistry(logger, { isDev: false });
  registry.register('test/echo', echoSchemas, handler);
  return registry;
}

beforeEach(() => {
  ipcMainHandle.mockClear();
});

describe('dispatch п.3 — валидный вызов (§13)', () => {
  it('payload доходит до хендлера валидированным, ответ — конверт {v:1, ok:true, data}', async () => {
    const { logger, warn, error } = fakeLogger();
    const handler = vi.fn((payload: { value: string }) => ({ value: payload.value }));
    const registry = registryWithEchoHandler(logger, handler);

    await expect(
      registry.dispatch({ channel: 'test/echo', payload: { value: 'тест' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'тест' } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 'тест' });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('асинхронный хендлер: Promise разрешается в успешный конверт (§9: async-хендлеры допустимы)', async () => {
    const logger = fakeLogger();
    const registry = registryWithEchoHandler(logger, async (payload) => {
      await Promise.resolve();
      return { value: payload.value.toUpperCase() };
    });

    await expect(
      registry.dispatch({ channel: 'test/echo', payload: { value: 'ab' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'AB' } });
  });
});

describe('dispatch п.2 — невалидный payload (§13, §20)', () => {
  it('VALIDATION/FAILED, хендлер НЕ вызван (spy не вызван — отклонение до handler)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn((payload: { value: string }) => ({ value: payload.value }));
    const registry = registryWithEchoHandler(logger, handler);

    await expect(
      registry.dispatch({ channel: 'test/echo', payload: { value: 42 } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: false, error: VALIDATION_FAILED_ERROR });

    expect(handler).not.toHaveBeenCalled();
  });

  it('strict-схема: неизвестные поля payload отклоняются (prototype-pollution, §14)', async () => {
    const logger = fakeLogger();
    const registry = registryWithEchoHandler(logger, (payload) => payload);

    await expect(
      registry.dispatch({ channel: 'test/echo', payload: { value: 'x', extra: true } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: false, error: VALIDATION_FAILED_ERROR });
  });
});

describe('dispatch п.3 — AppError из хендлера (§13, §20)', () => {
  it('приходит точным кодом и messageKey, cause наружу не проходит', async () => {
    const { logger, error } = fakeLogger();
    const registry = registryWithEchoHandler(logger, () => {
      // Контракт §13 п. 3: handler сигнализирует ошибкой типа AppError (не Error) —
      // каркас обязан перевести её в DTO; правилу only-throw-error это объяснено здесь.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw AppError.of(
        'APP/NOT_IMPLEMENTED',
        'errors.nyi',
        undefined,
        new Error('внутренняя причина'),
      );
    });

    const envelope = await registry.dispatch({ channel: 'test/echo', payload: { value: 'x' } });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error).toEqual({ code: 'APP/NOT_IMPLEMENTED', messageKey: 'errors.nyi' });
      expect('cause' in envelope.error).toBe(false);
    }
    // Ожидаемая ветка — не «необработанная ошибка», технический лог не пишется (§18).
    expect(error).not.toHaveBeenCalled();
  });
});

describe('dispatch п.4 — неизвестное исключение (§13, §18, §19)', () => {
  it('наружу APP/INTERNAL, cause — только в лог-спае каркаса', async () => {
    const { logger, error } = fakeLogger();
    const boom = new Error('boom: технические детали');
    const registry = registryWithEchoHandler(logger, () => {
      throw boom;
    });

    const envelope = await registry.dispatch({ channel: 'test/echo', payload: { value: 'x' } });

    expect(envelope).toEqual({ v: API_ENVELOPE_VERSION, ok: false, error: APP_INTERNAL_ERROR });
    expect(error).toHaveBeenCalledTimes(1);
    const [message, meta] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('test/echo');
    expect(meta['cause']).toBe(boom);
  });
});

describe('dispatch п.1 — неизвестный канал и битый запрос (§11, §13, §20)', () => {
  it('неизвестный канал → APP/INTERNAL + запись в лог', async () => {
    const { logger, error } = fakeLogger();
    const registry = createChannelRegistry(logger, { isDev: false });

    await expect(registry.dispatch({ channel: 'app/nope', payload: {} })).resolves.toEqual({
      v: API_ENVELOPE_VERSION,
      ok: false,
      error: APP_INTERNAL_ERROR,
    });

    expect(error).toHaveBeenCalledTimes(1);
    const [, meta] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta['channel']).toBe('app/nope');
  });

  it.each([undefined, null, 42, 'invoke', { payload: {} }, { channel: 7 }])(
    'битый транспортный запрос %j → APP/INTERNAL + лог (недоверенный рендерер, §14)',
    async (badRequest) => {
      const { logger, error } = fakeLogger();
      const registry = createChannelRegistry(logger, { isDev: false });

      await expect(registry.dispatch(badRequest)).resolves.toEqual({
        v: API_ENVELOPE_VERSION,
        ok: false,
        error: APP_INTERNAL_ERROR,
      });
      expect(error).toHaveBeenCalledTimes(1);
    },
  );
});

describe('register — дисциплина реестра (§9)', () => {
  it('повторная регистрация канала — fail fast', () => {
    const registry = createChannelRegistry(fakeLogger(), { isDev: false });
    registry.register('test/echo', echoSchemas, (payload) => payload);

    expect(() => registry.register('test/echo', echoSchemas, (payload) => payload)).toThrow(
      /test\/echo/,
    );
  });
});

describe('лимит payload 5 МБ (§5/§11: dev-режим — предупреждение в лог, не отказ)', () => {
  const bigSchemas = {
    request: z.object({ blob: z.string() }).strict(),
    response: z.object({ blob: z.string() }).strict(),
  };
  const bigPayload = { blob: 'x'.repeat(5 * 1024 * 1024 + 1) };

  it('в dev: oversize-payload обрабатывается и логируется предупреждением', async () => {
    const { logger, warn } = fakeLogger();
    const handler = vi.fn((payload: { blob: string }) => payload);
    const registry = createChannelRegistry(logger, { isDev: true });
    registry.register('test/big', bigSchemas, handler);

    await expect(registry.dispatch({ channel: 'test/big', payload: bigPayload })).resolves.toEqual({
      v: API_ENVELOPE_VERSION,
      ok: true,
      data: bigPayload,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ channel: 'test/big' });
  });

  it('не в dev: предупреждения нет (боевое окно не спамит лог)', async () => {
    const { logger, warn } = fakeLogger();
    const registry = createChannelRegistry(logger, { isDev: false });
    registry.register('test/big', bigSchemas, (payload) => payload);

    await registry.dispatch({ channel: 'test/big', payload: bigPayload });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('installChannelBridge — mock ipcMain (§19)', () => {
  it('регистрирует единственный транспортный канал hl:invoke', () => {
    installChannelBridge(createChannelRegistry(fakeLogger(), { isDev: false }));

    expect(ipcMainHandle).toHaveBeenCalledTimes(1);
    expect(ipcMainHandle).toHaveBeenCalledWith(HL_INVOKE_CHANNEL, expect.any(Function));
  });

  it('полный круг: хендлер ipcMain.handle с mock event возвращает конверт', async () => {
    const registry = registryWithEchoHandler(fakeLogger().logger, (payload) => ({
      value: payload.value,
    }));
    installChannelBridge(registry);

    const bridgeHandler = ipcMainHandle.mock.calls[0][1] as (
      event: unknown,
      request: unknown,
    ) => Promise<ApiEnvelope<unknown>>;
    const mockEvent = { senderFrame: { url: 'http://127.0.0.1:5183/' } };

    await expect(
      bridgeHandler(mockEvent, { channel: 'test/echo', payload: { value: 'круг' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'круг' } });
  });
});
