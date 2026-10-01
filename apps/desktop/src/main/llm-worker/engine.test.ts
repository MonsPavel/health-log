/**
 * TASK-077 §19: тесты движка БЕЗ модели — контракт управляемого движка
 * (createManagedLlamaEngine) на мок-бэкенде, GGUF-magic-валидация
 * (фикстура-байты), idle-unload (фейковые таймеры), отмена, коды ошибок.
 *
 * Нативный код node-llama-cpp здесь не участвует: бэкенд — порт (LlamaBackend),
 * подставляется моком; [model]-прогоны реального адаптера — llama-engine.test.ts
 * (ручной запуск, env HL_TEST_MODEL, §5/§24).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_DEFAULTS,
  IDLE_UNLOAD_MS,
  LLM_ENGINE_ERROR,
  createManagedLlamaEngine,
  resolveGenerationOptions,
  resolveIdleUnloadMs,
  validateModelFile,
  type LlamaBackend,
  type LlamaGenerateRequest,
  type LlamaModelSession,
  type LlmEngineLogCall,
  type LlmEngineLogger,
} from './engine.js';
import {
  EngineError,
  startLlmWorkerLoop,
  type WorkerCompleteParams,
  type WorkerTransport,
} from './protocol.js';
import type { WorkerResponse } from '@hl/contracts';

// --- фикстуры-файлы (§19: GGUF-magic — фиксстура-байты) ---

const dir = mkdtempSync(join(tmpdir(), 'hl-llm-engine-'));
/** Валидный заголовок: magic 'GGUF' (0x47 47 55 46) + хвост под метаданные. */
const VALID_MODEL_PATH = join(dir, 'valid.gguf');
/** Битый файл: magic не GGUF. */
const BROKEN_MODEL_PATH = join(dir, 'broken.gguf');
/** Короткий файл: меньше 4 байт. */
const TRUNCATED_MODEL_PATH = join(dir, 'truncated.gguf');
/** Несуществующий путь. */
const MISSING_MODEL_PATH = join(dir, 'missing.gguf');

writeFileSync(VALID_MODEL_PATH, Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(16, 1)]));
writeFileSync(BROKEN_MODEL_PATH, Buffer.concat([Buffer.from('NOPE', 'ascii'), Buffer.alloc(8, 0)]));
writeFileSync(TRUNCATED_MODEL_PATH, Buffer.from('GG', 'ascii'));

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- моки §19 ---

/** Мок-сессия бэкенда: стримит заданные дельты, отмена — по signal. */
class MockSession implements LlamaModelSession {
  readonly generateRequests: Array<{
    readonly temperature: number;
    readonly seed: number | undefined;
    readonly maxTokens: number;
    readonly signal: AbortSignal;
  }> = [];
  disposed = false;
  disposeCount = 0;

  constructor(private readonly deltas: readonly string[] = ['а ', 'б ']) {}

  generate(request: LlamaGenerateRequest): Promise<'stop' | 'cancelled'> {
    this.generateRequests.push({
      temperature: request.temperature,
      seed: request.seed,
      maxTokens: request.maxTokens,
      signal: request.signal,
    });
    const step = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
    return (async () => {
      for (const delta of this.deltas) {
        if (request.signal.aborted) {
          return 'cancelled';
        }
        await step(); // шаг макротаски — тест/цикл успевают отменить между дельтами
        if (request.signal.aborted) {
          return 'cancelled';
        }
        request.onToken(delta);
      }
      return 'stop';
    })();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposeCount += 1;
    return Promise.resolve();
  }
}

/** Мок-бэкенд: создаёт сессии из очереди скриптов дельт. */
function createMockBackend(sessionDeltas: readonly string[][] = [['а ', 'б ']]): {
  backend: LlamaBackend;
  sessions: MockSession[];
  loadCalls: Array<{ readonly modelPath: string; readonly contextSize: number }>;
} {
  const sessions: MockSession[] = [];
  const loadCalls: Array<{ readonly modelPath: string; readonly contextSize: number }> = [];
  let index = 0;
  const backend: LlamaBackend = {
    loadModel: (modelPath, config) => {
      loadCalls.push({ modelPath, contextSize: config.contextSize });
      const session = new MockSession(sessionDeltas[index] ?? ['а ', 'б ']);
      index += 1;
      sessions.push(session);
      return Promise.resolve(session);
    },
  };
  return { backend, sessions, loadCalls };
}

/** Логгер-шпион (§18: ассерты по фактам вызова). */
function createLoggerSpy(): { logger: LlmEngineLogger; calls: LlmEngineLogCall[] } {
  const calls: LlmEngineLogCall[] = [];
  const push =
    (level: LlmEngineLogCall['level']) =>
    (message: string, meta = {}) => {
      calls.push({ level, message, meta });
    };
  const logger: LlmEngineLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  return { logger, calls };
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Ждёт предикат реальными таймерами (микротасочные движки — без fake timers). */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await tick();
  }
  expect(predicate(), `не дождались: ${what}`).toBe(true);
}

// --- GGUF-magic-валидация (§13) ---

describe('validateModelFile — GGUF-magic (§13 фиксстура-байты)', () => {
  it('несуществующий файл → EngineError AI/MODEL_FILE_MISSING', () => {
    try {
      validateModelFile(MISSING_MODEL_PATH);
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(EngineError);
      expect((cause as EngineError).workerErrorCode).toBe(LLM_ENGINE_ERROR.MODEL_FILE_MISSING);
    }
  });

  it('каталог вместо файла → AI/MODEL_FILE_MISSING', () => {
    expect(() => validateModelFile(dir)).toThrowError(
      expect.objectContaining({ workerErrorCode: LLM_ENGINE_ERROR.MODEL_FILE_MISSING }),
    );
  });

  it('битый magic («NOPE») → AI/MODEL_INVALID', () => {
    expect(() => validateModelFile(BROKEN_MODEL_PATH)).toThrowError(
      expect.objectContaining({ workerErrorCode: LLM_ENGINE_ERROR.MODEL_INVALID }),
    );
  });

  it('файл короче 4 байт → AI/MODEL_INVALID', () => {
    expect(() => validateModelFile(TRUNCATED_MODEL_PATH)).toThrowError(
      expect.objectContaining({ workerErrorCode: LLM_ENGINE_ERROR.MODEL_INVALID }),
    );
  });

  it('валидный magic «GGUF» проходит', () => {
    expect(() => validateModelFile(VALID_MODEL_PATH)).not.toThrow();
  });
});

// --- load: коды ошибок, контекст, перезагрузка (§5/§13) ---

describe('createManagedLlamaEngine — load (§5/§13)', () => {
  it('load несуществующего → AI/MODEL_FILE_MISSING, бэкенд не вызван', async () => {
    const { backend, loadCalls } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    await expect(engine.load(MISSING_MODEL_PATH)).rejects.toMatchObject({
      workerErrorCode: LLM_ENGINE_ERROR.MODEL_FILE_MISSING,
    });
    expect(loadCalls).toEqual([]);
  });

  it('load битого GGUF → AI/MODEL_INVALID, нативная часть не вызывается (краш-защита §13)', async () => {
    const { backend, loadCalls } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    await expect(engine.load(BROKEN_MODEL_PATH)).rejects.toMatchObject({
      workerErrorCode: LLM_ENGINE_ERROR.MODEL_INVALID,
    });
    expect(loadCalls).toEqual([]);
  });

  it('нативный отказ loadModel → AI/MODEL_INVALID (обёртка try §13)', async () => {
    const failingBackend: LlamaBackend = {
      loadModel: () => Promise.reject(new Error('gguf: invalid metadata')),
    };
    const engine = createManagedLlamaEngine(failingBackend);

    await expect(engine.load(VALID_MODEL_PATH)).rejects.toMatchObject({
      workerErrorCode: LLM_ENGINE_ERROR.MODEL_INVALID,
    });
  });

  it('успешный load передаёт бэкенду путь и контекст-дефолт 4096 (§4)', async () => {
    const { backend, loadCalls, sessions } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    await expect(engine.load(VALID_MODEL_PATH)).resolves.toBeUndefined();
    expect(loadCalls).toEqual([{ modelPath: VALID_MODEL_PATH, contextSize: 4096 }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.disposed).toBe(false);
  });

  it('повторный load → перезагрузка: прежняя сессия выгружена, активна новая (§5)', async () => {
    const { backend, loadCalls, sessions } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    await engine.load(VALID_MODEL_PATH);
    await engine.load(VALID_MODEL_PATH);

    expect(loadCalls).toHaveLength(2);
    expect(sessions[0]?.disposed).toBe(true);
    expect(sessions[1]?.disposed).toBe(false);
  });

  it('unload(): сессия выгружается; без модели — идемпотентный no-op', async () => {
    const { backend, sessions } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    await expect(engine.unload()).resolves.toBeUndefined(); // no-op без модели

    await engine.load(VALID_MODEL_PATH);
    await engine.unload();
    expect(sessions[0]?.disposed).toBe(true);
  });
});

// --- complete: стрим, no-model, дефолты, телеметрия (§7/§18) ---

const COMPLETE_REQUEST: WorkerCompleteParams = {
  requestId: 'gen-1',
  messages: [{ role: 'user', content: 'резюме периода' }],
  maxTokens: 2,
};

describe('createManagedLlamaEngine — complete (§5/§13/§18)', () => {
  it('генерация без модели → EngineError AI/NO_MODEL', async () => {
    const { backend } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    await expect(engine.complete(COMPLETE_REQUEST, () => undefined)).rejects.toMatchObject({
      workerErrorCode: LLM_ENGINE_ERROR.NO_MODEL,
    });
  });

  it('стрим дельт идёт в emit, finishReason пробрасывается', async () => {
    const { backend } = createMockBackend([['а ', 'б ']]);
    const engine = createManagedLlamaEngine(backend);
    await engine.load(VALID_MODEL_PATH);

    const deltas: string[] = [];
    await expect(engine.complete(COMPLETE_REQUEST, (delta) => deltas.push(delta))).resolves.toBe(
      'stop',
    );
    expect(deltas.join('')).toBe('а б ');
  });

  it('resolveGenerationOptions — дефолты §7: temperature 0.3, maxTokens 1024, seed опционален', () => {
    expect(resolveGenerationOptions(undefined, 256)).toEqual({
      temperature: GENERATION_DEFAULTS.temperature,
      maxTokens: 256,
    });
    expect(
      resolveGenerationOptions({ temperature: 0.8, seed: 42 }, GENERATION_DEFAULTS.maxTokens),
    ).toEqual({ temperature: 0.8, seed: 42, maxTokens: GENERATION_DEFAULTS.maxTokens });
    expect(resolveGenerationOptions(undefined, undefined)).toEqual({
      temperature: GENERATION_DEFAULTS.temperature,
      maxTokens: GENERATION_DEFAULTS.maxTokens,
    });
  });

  it('сессия получает дефолтную температуру и maxTokens запроса', async () => {
    const { backend, sessions } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);
    await engine.load(VALID_MODEL_PATH);

    await engine.complete(COMPLETE_REQUEST, () => undefined);

    const request = sessions[0]?.generateRequests[0];
    expect(request?.temperature).toBe(0.3);
    expect(request?.maxTokens).toBe(2);
    expect(request?.seed).toBeUndefined();
  });

  it('telemetry §18: tokens/tps/firstTokenMs по инжектируемым часам, без текста', async () => {
    const { backend } = createMockBackend([['а ', 'б ', 'в ', 'г ']]);
    const { logger, calls } = createLoggerSpy();
    let time = 0;
    const engine = createManagedLlamaEngine(backend, {
      logger,
      now: () => time,
      idleUnloadMs: 60_000,
    });
    await engine.load(VALID_MODEL_PATH);

    let tokenCount = 0;
    const done = engine.complete(COMPLETE_REQUEST, () => {
      tokenCount += 1;
      if (tokenCount === 1) {
        time = 500; // первый токен «на 500-й мс» (замер — после доставки дельты)
      }
      if (tokenCount === 4) {
        time = 2_000; // конец генерации — после последней дельты
      }
    });
    await done;

    const stats = calls.find((call) => 'tokens' in call.meta);
    expect(stats).toBeDefined();
    expect(stats?.meta).toMatchObject({ requestId: 'gen-1', tokens: 4, firstTokenMs: 500 });
    // 4 токена за 2 с → tps 2
    expect((stats?.meta as { tps: number }).tps).toBe(2);
    // §18: текст генерации и промпт в лог не попадают
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('резюме периода');
  });
});

// --- cancel (§13) ---

describe('createManagedLlamaEngine — cancel (§13)', () => {
  it('cancel активной генерации: signal абортится, complete завершается cancelled', async () => {
    const { backend, sessions } = createMockBackend([['а ', 'б ', 'в ', 'г ']]);
    const engine = createManagedLlamaEngine(backend);
    await engine.load(VALID_MODEL_PATH);

    const deltas: string[] = [];
    const done = engine.complete(COMPLETE_REQUEST, (delta) => deltas.push(delta));
    await waitFor(() => deltas.length >= 1, 'первый токен');

    engine.cancel('gen-1');
    await expect(done).resolves.toBe('cancelled');
    // после отмены дельты не приходят (стрим остановлен)
    const lengthAtCancel = deltas.length;
    await tick();
    await tick();
    expect(deltas.length).toBe(lengthAtCancel);

    expect(sessions[0]?.generateRequests[0]?.signal.aborted).toBe(true);
  });

  it('cancel незнакомого requestId и повторный cancel — тихий no-op (идемпотентность §13)', async () => {
    const { backend } = createMockBackend();
    const engine = createManagedLlamaEngine(backend);

    expect(() => engine.cancel('unknown')).not.toThrow();

    await engine.load(VALID_MODEL_PATH);
    const done = engine.complete(COMPLETE_REQUEST, () => undefined);
    engine.cancel('чужой');
    await expect(done).resolves.toBe('stop');
    engine.cancel('gen-1'); // после завершения — no-op
  });
});

// --- idle-unload (§5: 5 минут простоя; §19 — фейковые таймеры) ---

describe('createManagedLlamaEngine — idle-unload (§5/§19)', () => {
  it('модель без генераций выгружается через IDLE_UNLOAD_MS с логом idle', async () => {
    vi.useFakeTimers();
    const { backend, sessions } = createMockBackend();
    const { logger, calls } = createLoggerSpy();
    const engine = createManagedLlamaEngine(backend, { logger, idleUnloadMs: IDLE_UNLOAD_MS });

    await engine.load(VALID_MODEL_PATH);
    expect(sessions[0]?.disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1);
    expect(sessions[0]?.disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(sessions[0]?.disposed).toBe(true);
    expect(calls.some((call) => (call.meta as { reason?: string }).reason === 'idle')).toBe(true);
  });

  it('генерация откладывает выгрузку; после неё таймер заводится заново', async () => {
    vi.useFakeTimers();
    const { backend, sessions } = createMockBackend([['а ']]);
    const engine = createManagedLlamaEngine(backend, { idleUnloadMs: 1_000 });

    await engine.load(VALID_MODEL_PATH);
    // генерация «висит» дольше idle-окна — выгрузки нет
    let release: (() => void) | undefined;
    sessions[0]!.generate = () =>
      new Promise<'stop'>((resolve) => {
        release = () => {
          resolve('stop');
        };
      });
    const done = engine.complete(COMPLETE_REQUEST, () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessions[0]?.disposed).toBe(false);

    release?.();
    await done;
    // после генерации таймер перезапущен: окно простоя — с момента завершения
    await vi.advanceTimersByTimeAsync(999);
    expect(sessions[0]?.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions[0]?.disposed).toBe(true);
  });

  it('сокращённое окно через опцию (§20 env-механика); после idle-unload генерация → AI/NO_MODEL', async () => {
    vi.useFakeTimers();
    const { backend, sessions } = createMockBackend();
    const engine = createManagedLlamaEngine(backend, { idleUnloadMs: 100 });

    await engine.load(VALID_MODEL_PATH);
    await vi.advanceTimersByTimeAsync(100);
    expect(sessions[0]?.disposed).toBe(true);

    await expect(engine.complete(COMPLETE_REQUEST, () => undefined)).rejects.toMatchObject({
      workerErrorCode: LLM_ENGINE_ERROR.NO_MODEL,
    });
  });

  it('ручной unload отменяет idle-таймер: двойной dispose не случается', async () => {
    vi.useFakeTimers();
    const { backend, sessions } = createMockBackend();
    const engine = createManagedLlamaEngine(backend, { idleUnloadMs: 1_000 });

    await engine.load(VALID_MODEL_PATH);
    await engine.unload();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessions[0]?.disposed).toBe(true); // выгружена вручную
    expect(sessions[0]?.disposeCount).toBe(1); // повторного dispose по таймеру нет
  });

  it('resolveIdleUnloadMs: валидное число — значение, мусор/не-позитив — дефолт 5 минут (§20)', () => {
    expect(resolveIdleUnloadMs(undefined)).toBe(IDLE_UNLOAD_MS);
    expect(resolveIdleUnloadMs('1000')).toBe(1000);
    expect(resolveIdleUnloadMs('abc')).toBe(IDLE_UNLOAD_MS);
    expect(resolveIdleUnloadMs('0')).toBe(IDLE_UNLOAD_MS);
    expect(resolveIdleUnloadMs('-5')).toBe(IDLE_UNLOAD_MS);
    expect(resolveIdleUnloadMs('12.5')).toBe(IDLE_UNLOAD_MS);
  });
});

// --- мок-движок проходит протокол 076 (§19) ---

describe('мок-движок за протоколом 076 (§19)', () => {
  function createFakeTransport(): {
    transport: WorkerTransport;
    sent: WorkerResponse[];
    receive(raw: unknown): void;
  } {
    const sent: WorkerResponse[] = [];
    let listener: ((raw: unknown) => void) | undefined;
    const transport: WorkerTransport = {
      postMessage: (message) => {
        sent.push(message);
      },
      onRequest: (l) => {
        // Транспорт контрактурует: raw — всегда WorkerRequest (протокол 076 §7);
        // храним в unknown-сигнатуре фасада receive(raw: unknown).
        listener = l as (raw: unknown) => void;
      },
    };
    return { transport, sent, receive: (raw) => listener?.(raw) };
  }

  it('load → ready, complete → token/done(stop) — маппинг протокола 076', async () => {
    const { backend } = createMockBackend([['а ', 'б ']]);
    const engine = createManagedLlamaEngine(backend, { idleUnloadMs: 60_000 });
    const fake = createFakeTransport();
    startLlmWorkerLoop(fake.transport, engine);

    fake.receive({ type: 'load', modelPath: VALID_MODEL_PATH });
    await waitFor(() => fake.sent.some((m) => m.type === 'ready'), 'ready после load');
    expect(fake.sent.some((m) => m.type === 'error')).toBe(false);

    fake.receive({
      type: 'complete',
      requestId: 'gen-1',
      messages: [{ role: 'user', content: 'резюме' }],
      maxTokens: 2,
    });
    await waitFor(
      () => fake.sent.some((m) => m.type === 'done') && fake.sent.some((m) => m.type === 'token'),
      'token+done',
    );
    expect(fake.sent.filter((m) => m.type === 'token')).toEqual([
      { type: 'token', requestId: 'gen-1', delta: 'а ' },
      { type: 'token', requestId: 'gen-1', delta: 'б ' },
    ]);
    expect(fake.sent.at(-1)).toEqual({ type: 'done', requestId: 'gen-1', finishReason: 'stop' });
  });

  it('без модели → адресный error AI/NO_MODEL; cancel посреди → done(cancelled)', async () => {
    const { backend } = createMockBackend([['а ', 'б ', 'в ']]);
    const engine = createManagedLlamaEngine(backend, { idleUnloadMs: 60_000 });
    const fake = createFakeTransport();
    startLlmWorkerLoop(fake.transport, engine);

    // без модели: адресный error AI/NO_MODEL
    fake.receive({
      type: 'complete',
      requestId: 'gen-0',
      messages: [{ role: 'user', content: 'вопрос' }],
      maxTokens: 2,
    });
    await waitFor(
      () => fake.sent.some((m) => m.type === 'error' && m.code === LLM_ENGINE_ERROR.NO_MODEL),
      'AI/NO_MODEL без модели',
    );

    fake.receive({ type: 'load', modelPath: VALID_MODEL_PATH });
    await waitFor(() => fake.sent.some((m) => m.type === 'ready'), 'ready');

    fake.receive({
      type: 'complete',
      requestId: 'gen-2',
      messages: [{ role: 'user', content: 'резюме' }],
      maxTokens: 3,
    });
    await waitFor(
      () => fake.sent.filter((m) => m.type === 'token' && m.requestId === 'gen-2').length >= 1,
      'первый токен gen-2',
    );
    fake.receive({ type: 'cancel', requestId: 'gen-2' });
    await waitFor(
      () =>
        fake.sent.some(
          (m) => m.type === 'done' && m.requestId === 'gen-2' && m.finishReason === 'cancelled',
        ),
      'done(cancelled)',
    );
  });
});
