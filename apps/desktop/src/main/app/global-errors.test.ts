/**
 * TASK-011 §19/§20: тест глобальных хендлеров main с подменёнными process.on-регистрациями
 * (fake-target, Electron не запускается) — вызов → лог-спай + диалог-спай (mock showDialog);
 * guard-счётчик диалогов; §13 — ошибка внутри обработчика ошибки идёт в stderr без рекурсии.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { HlLogger } from '../shared/logger/logger.js';
import {
  createGlobalErrorHandler,
  createLogClientErrorHandler,
  installGlobalErrorHandlers,
  type ProcessErrorTarget,
} from './global-errors.js';

/** Логгер-спай: error — шпион, остальные уровни — заглушки (§19). */
function makeLogger(): { logger: HlLogger; error: Mock } {
  const error = vi.fn();
  const logger: HlLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error,
    fatal: vi.fn(),
  };
  return { logger, error };
}

/** Один macrotask — все микротаски (цепочки .finally у диалога) успевают выполниться. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fake process-подобного target: ловит регистрации обработчиков (§19). */
function makeTarget(): {
  target: ProcessErrorTarget;
  listeners: Map<string, (error: unknown) => void>;
} {
  const listeners = new Map<string, (error: unknown) => void>();
  const target: ProcessErrorTarget = {
    on(event, listener) {
      listeners.set(event, listener as (error: unknown) => void);
      return target;
    },
  };
  return { target, listeners };
}

/** Модальный диалог: промис без разрешения — пользователь ещё не кликнул (§9). */
const pendingDialog = (): Promise<unknown> => new Promise(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installGlobalErrorHandlers — регистрация на process-подобном target (§19)', () => {
  it('ставит обработчики uncaughtException и unhandledRejection', () => {
    const { target, listeners } = makeTarget();
    const { logger } = makeLogger();

    installGlobalErrorHandlers({ logger, showDialog: pendingDialog }, target);

    expect(listeners.has('uncaughtException')).toBe(true);
    expect(listeners.has('unhandledRejection')).toBe(true);
  });
});

describe('createGlobalErrorHandler — вызов → лог + диалог (§20 п. 1)', () => {
  it('необработанное исключение: лог error с cause в метах и диалог 1 раз', () => {
    const { logger, error } = makeLogger();
    const showDialog = vi.fn(pendingDialog);
    const handle = createGlobalErrorHandler({ logger, showDialog });

    const boom = new Error('boom');
    handle(boom, 'uncaughtException');

    expect(error).toHaveBeenCalledTimes(1);
    const [message, meta] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('diagnostic');
    expect(meta['err']).toBe(boom); // cause уходит в лог (сериализатор err, TASK-010)
    expect(meta['kind']).toBe('uncaughtException');

    expect(showDialog).toHaveBeenCalledTimes(1);
  });

  it('unhandledRejection: reason логируется и диалог показывается (§5)', () => {
    const { logger, error } = makeLogger();
    const showDialog = vi.fn(pendingDialog);
    const handle = createGlobalErrorHandler({ logger, showDialog });

    const reason = 'строка вместо ошибки';
    handle(reason, 'unhandledRejection');

    const [, meta] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta['err']).toBe(reason);
    expect(meta['kind']).toBe('unhandledRejection');
    expect(showDialog).toHaveBeenCalledTimes(1);
  });

  it('текст диалога — константа с кодом, без message исключения (§14)', () => {
    const { logger } = makeLogger();
    const showDialog = vi.fn(pendingDialog);
    const handle = createGlobalErrorHandler({ logger, showDialog });

    handle(new Error('C:\\Users\\секрет\\путь'), 'uncaughtException');

    const text = showDialog.mock.calls[0]?.[0] as string;
    expect(text).toBe('Произошла непредвиденная ошибка. Данные не затронуты. Код: APP/INTERNAL');
    expect(text).not.toContain('секрет'); // §14: только code, никаких путей/данных
  });
});

describe('guard диалогов (§5/§9, §20 п. 2)', () => {
  it('6 подряд ошибок — диалог 1 раз, в логе 6 записей', () => {
    const { logger, error } = makeLogger();
    const showDialog = vi.fn(pendingDialog);
    const handle = createGlobalErrorHandler({ logger, showDialog });

    for (let i = 0; i < 6; i += 1) {
      handle(new Error(`e${String(i)}`), 'uncaughtException');
    }

    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(6);
  });

  it('серия >5: даже свободный диалог молчит — только тихий лог (§5)', async () => {
    const { logger, error } = makeLogger();
    const showDialog = vi.fn(() => Promise.resolve()); // диалог закрывается мгновенно
    const handle = createGlobalErrorHandler({ logger, showDialog });

    for (let i = 0; i < 6; i += 1) {
      handle(new Error(`e${String(i)}`), 'uncaughtException');
    }
    await flush();

    // 1-я ошибка открыла диалог, 2–6 подавлены «не более 1 активного»; серия не угасла.
    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(6);

    handle(new Error('e6'), 'uncaughtException'); // 7-я подряд — счётчик >5 → тихий лог
    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(7);
  });

  it('серия угасла (диалог закрыт, новых ошибок не было) — одиночная ошибка снова показывает диалог', async () => {
    const { logger } = makeLogger();
    const showDialog = vi.fn(() => Promise.resolve());
    const handle = createGlobalErrorHandler({ logger, showDialog });

    handle(new Error('e1'), 'uncaughtException');
    await flush(); // диалог закрыт, во время него ошибок не было → счётчик сброшен

    handle(new Error('e2'), 'uncaughtException');
    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it('showDialog отклонился — хендлер не бросает, следующий диалог снова возможен', async () => {
    const { logger } = makeLogger();
    const showDialog = vi.fn(() => Promise.reject(new Error('ui недоступен')));
    const handle = createGlobalErrorHandler({ logger, showDialog });

    expect(() => handle(new Error('e1'), 'uncaughtException')).not.toThrow();
    await flush();

    handle(new Error('e2'), 'uncaughtException');
    expect(showDialog).toHaveBeenCalledTimes(2);
  });
});

describe('отказобезопасность (§13)', () => {
  it('ошибка внутри обработчика ошибки — stderr напрямую, без диалога и без исключения', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { logger, error } = makeLogger();
    error.mockImplementation(() => {
      throw new Error('логгер упал');
    });
    const showDialog = vi.fn(pendingDialog);
    const handle = createGlobalErrorHandler({ logger, showDialog });

    expect(() => handle(new Error('boom'), 'uncaughtException')).not.toThrow();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(showDialog).not.toHaveBeenCalled();
  });
});

describe('createLogClientErrorHandler — канал app/log-client-error (§9/§18)', () => {
  it('клиентский отчёт — в общий лог с source: renderer, digest; handler возвращает null', () => {
    const { logger, error } = makeLogger();
    const handle = createLogClientErrorHandler(logger);

    const result = handle({
      code: 'APP/RENDERER',
      messageKey: 'errors.renderer',
      digest: '1a2b3c4d',
    });

    // §9: handler → null; конверт {ok:true, data:null} ставит каркас register-channel.
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const [message, meta] = error.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('ошибка рендерера (ErrorBoundary)');
    expect(meta['source']).toBe('renderer'); // §18
    expect(meta['code']).toBe('APP/RENDERER');
    expect(meta['messageKey']).toBe('errors.renderer');
    expect(meta['digest']).toBe('1a2b3c4d');
  });

  it('сбой логирования глушится — логгер не ломает UI цепочкой (§9)', () => {
    const { logger, error } = makeLogger();
    error.mockImplementation(() => {
      throw new Error('pino упал');
    });
    const handle = createLogClientErrorHandler(logger);

    expect(() =>
      handle({ code: 'APP/RENDERER', messageKey: 'errors.renderer', digest: 'd' }),
    ).not.toThrow();
  });
});
