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
  RECOVERY_MODE_ERROR,
  VALIDATION_FAILED_ERROR,
  type ApiEnvelope,
  type ChannelName,
} from '@hl/contracts';
import { AppError } from '@hl/kernel';

import {
  createChannelRegistry,
  installChannelBridge,
  type ChannelHandler,
  type ChannelRegistry,
  type IpcLogger,
} from './register-channel.js';

/** Конверт отказа recovery-гвардии (точная форма, §11). */
const RECOVERY_MODE_ENVELOPE = { v: API_ENVELOPE_VERSION, ok: false, error: RECOVERY_MODE_ERROR };

/**
 * Синтетическое имя тестового канала: каркас типизирован боевым union ChannelName,
 * которого в тесте каналов нет — cast зеркалит транспортную реальность (dispatch
 * сам приводит строку рендерера к ChannelName, register-channel.ts §13).
 */
const testChannel = (name: string): ChannelName => name as ChannelName;

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
  handler: ChannelHandler<{ value: string }, { value: string }>,
): ChannelRegistry {
  const registry = createChannelRegistry(logger, { isDev: false });
  registry.register(testChannel('test/echo'), echoSchemas, handler);
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
    registry.register(testChannel('test/echo'), echoSchemas, (payload) => payload);

    expect(() =>
      registry.register(testChannel('test/echo'), echoSchemas, (payload) => payload),
    ).toThrow(/test\/echo/);
  });
});

// TASK-094 §7/§11/§14: гвардия requireUnlocked — ЕДИНАЯ обёртка каркаса: канал,
// помеченный secure: true в реестре контрактов, отклоняется ДО вызова хендлера,
// пока сессия заблокирована; идемпотентный idle-трекер — любой валидный вызов
// hl.* обновляет lastActivity (§9, один патч каркаса).
describe('гвардия requireUnlocked и idle-трекер (TASK-094 §7/§9/§11, AC5)', () => {
  const secureSchemas = {
    request: z.object({}).strict(),
    response: z.object({ value: z.string() }).strict(),
    secure: true,
  };

  it('secure-канал при locked: конверт VAULT/LOCKED, хендлер НЕ вызывается (§7/§14)', async () => {
    const { logger, error } = fakeLogger();
    const handler = vi.fn(() => ({ value: 'данные' }));
    const registry = createChannelRegistry(logger, {
      isDev: false,
      isUnlocked: () => false,
    });
    registry.register(testChannel('test/db'), secureSchemas, handler);

    await expect(registry.dispatch({ channel: 'test/db', payload: {} })).resolves.toEqual({
      v: API_ENVELOPE_VERSION,
      ok: false,
      error: { code: 'VAULT/LOCKED', messageKey: 'errors.VAULT_LOCKED' },
    });
    expect(handler).not.toHaveBeenCalled();
    // Ожидаемая ветка гвардии — не «необработанная ошибка» (§18).
    expect(error).not.toHaveBeenCalled();
  });

  it('secure-канал при unlocked: хендлер вызывается (guard прозрачен)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'данные' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
    });
    registry.register(testChannel('test/db'), secureSchemas, handler);

    await expect(registry.dispatch({ channel: 'test/db', payload: {} })).resolves.toEqual({
      v: API_ENVELOPE_VERSION,
      ok: true,
      data: { value: 'данные' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('канал без secure-флага не гвардится (vault/* доступны при locked)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'ok' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => false,
    });
    registry.register(testChannel('test/open'), echoSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/open', payload: { value: 'x' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'ok' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('без isUnlocked в опциях гвардия не активна (обратная совместимость тестов каркаса)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'данные' }));
    const registry = createChannelRegistry(logger.logger, { isDev: false });
    registry.register(testChannel('test/db'), secureSchemas, handler);

    await expect(registry.dispatch({ channel: 'test/db', payload: {} })).resolves.toEqual({
      v: API_ENVELOPE_VERSION,
      ok: true,
      data: { value: 'данные' },
    });
  });

  it('валидация payload идёт ДО гвардии (невалидный payload при locked — VALIDATION/FAILED)', async () => {
    const logger = fakeLogger();
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => false,
    });
    registry.register(testChannel('test/db'), secureSchemas, () => ({ value: 'x' }));

    await expect(registry.dispatch({ channel: 'test/db', payload: { extra: 1 } })).resolves.toEqual(
      { v: API_ENVELOPE_VERSION, ok: false, error: VALIDATION_FAILED_ERROR },
    );
  });

  it('idle-трекер: любой валидный запрос hl.* вызывает onActivity (§9 — один патч каркаса)', async () => {
    const logger = fakeLogger();
    const onActivity = vi.fn();
    const registry = createChannelRegistry(logger.logger, { isDev: false, onActivity });
    registry.register(testChannel('test/echo'), echoSchemas, (payload) => payload);

    await registry.dispatch({ channel: 'test/echo', payload: { value: 'раз' } });
    await registry.dispatch({ channel: 'test/echo', payload: { value: 'два' } });
    await registry.dispatch({ channel: 'test/nope', payload: {} }); // неизвестный канал — тоже активность
    await registry.dispatch({ channel: 'test/echo', payload: { extra: 1 } }); // невалидный payload — тоже
    expect(onActivity).toHaveBeenCalledTimes(4);

    // Битый транспортный запрос (не hl.*-форма) активностью не считается.
    await registry.dispatch({ payload: {} });
    expect(onActivity).toHaveBeenCalledTimes(4);
  });
});

describe('гвардия recovery-режима (TASK-101 §5/§9/§11/§14)', () => {
  const secureSchemas = {
    request: z.object({ value: z.string() }).strict(),
    response: z.object({ value: z.string() }).strict(),
    secure: true,
  } as const;

  it('secure-канал вне разрешённого набора при recovery: STORAGE/RECOVERY_MODE до handler (§11)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'x' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
      isRecovery: () => true,
      recoveryAllowed: ['test/allowed'],
    });
    registry.register(testChannel('test/db'), secureSchemas, handler);
    registry.register(testChannel('test/allowed'), secureSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/db', payload: { value: 'x' } }),
    ).resolves.toStrictEqual(RECOVERY_MODE_ENVELOPE);
    expect(handler).not.toHaveBeenCalled();
  });

  it('secure-канал из разрешённого набора при recovery работает (backup/restore, §9)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'x' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
      isRecovery: () => true,
      recoveryAllowed: ['test/allowed'],
    });
    registry.register(testChannel('test/allowed'), secureSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/allowed', payload: { value: 'x' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'x' } });
  });

  it('не-secure каналы при recovery не гвардятся (app/*, file/open-dialog — §9)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'x' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
      isRecovery: () => true,
      recoveryAllowed: [],
    });
    registry.register(testChannel('test/open'), echoSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/open', payload: { value: 'x' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'x' } });
  });

  it('вне recovery гвардия прозрачна даже при заданном recoveryAllowed', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'x' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
      isRecovery: () => false,
      recoveryAllowed: ['test/allowed'],
    });
    registry.register(testChannel('test/db'), secureSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/db', payload: { value: 'x' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'x' } });
  });

  it('recovery-гвардия ДО валидации payload (поверхность максимальна узкая — §14: для заблокированного канала не работает даже zod)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'x' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
      isRecovery: () => true,
      recoveryAllowed: [],
    });
    registry.register(testChannel('test/db'), secureSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/db', payload: { extra: 1 } }),
    ).resolves.toStrictEqual(RECOVERY_MODE_ENVELOPE);
    expect(handler).not.toHaveBeenCalled();
  });

  it('разрешённый secure-канал: валидация payload работает (невалидный — VALIDATION/FAILED, не RECOVERY_MODE)', async () => {
    const logger = fakeLogger();
    const handler = vi.fn(() => ({ value: 'x' }));
    const registry = createChannelRegistry(logger.logger, {
      isDev: false,
      isUnlocked: () => true,
      isRecovery: () => true,
      recoveryAllowed: ['test/allowed'],
    });
    registry.register(testChannel('test/allowed'), secureSchemas, handler);

    await expect(
      registry.dispatch({ channel: 'test/allowed', payload: { extra: 1 } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: false, error: VALIDATION_FAILED_ERROR });
    expect(handler).not.toHaveBeenCalled();
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
    registry.register(testChannel('test/big'), bigSchemas, handler);

    await expect(registry.dispatch({ channel: 'test/big', payload: bigPayload })).resolves.toEqual({
      v: API_ENVELOPE_VERSION,
      ok: true,
      data: bigPayload,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ channel: 'test/big' });
  });

  it('не в dev: предупреждения нет (боевое окно не спамит лог)', async () => {
    const { logger, warn } = fakeLogger();
    const registry = createChannelRegistry(logger, { isDev: false });
    registry.register(testChannel('test/big'), bigSchemas, (payload) => payload);

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

    const bridgeHandler = ipcMainHandle.mock.calls[0]![1] as (
      event: unknown,
      request: unknown,
    ) => Promise<ApiEnvelope<unknown>>;
    const mockEvent = { senderFrame: { url: 'http://127.0.0.1:5183/' } };

    await expect(
      bridgeHandler(mockEvent, { channel: 'test/echo', payload: { value: 'круг' } }),
    ).resolves.toEqual({ v: API_ENVELOPE_VERSION, ok: true, data: { value: 'круг' } });
  });
});
