/**
 * TASK-076 §19/§20/§24: интеграционные тесты llm-worker — ПОЛНЫЙ стек: клиент
 * LlmProcessClient (боевой код) + MessagePort-транспорт + РЕАЛЬНЫЙ цикл воркера
 * (protocol.ts) + echo-движок (fake: стримит maxTokens токенов, латентность
 * ≤10 мс/токен — §15).
 *
 * ПРО ТРАНСПОРТ честно: Electron UtilityProcess недоступен вне Electron-рантайма
 * (vitest — node), поэтому процессная граница симулируется in-process-каналом с
 * макротаскичной доставкой и crash/kill-семантикой (порт мёртв + exit у main).
 * Весь код протокола/клиента/лупа при этом боевой; Electron-специфика — тонкий
 * адаптер createDefaultLlmWorkerSpawn (структурно типизирован, handshake-проводка
 * покрыта юнитами main.test.ts). Прецедент объёма интеграции — pool.int.test.ts
 * TASK-066 (боевой worker.ts на реальных потоках, задачи — fake-модуль).
 *
 * Матрица §19 (§20 AC1–AC5):
 *  1. полный цикл load → complete → стрим 10 токенов (пачками ≤flush) → done(stop);
 *  2. cancel посреди — поток останавливается, done(cancelled);
 *  3. BUSY на второй параллельной (код AI/BUSY);
 *  4. unload при активной генерации отклонён; после done — unloaded;
 *  5. краш воркера (env-хук HL_FAKE_WORKER_CRASH, §5 — one-shot) → активный
 *     requestId отклонён AI/WORKER_CRASHED, автоперезапуск + авто-reload,
 *     следующая генерация успешна, ai:status restarting доставлен;
 *  6. боевой каркас без движка (notConfiguredEngine) → AI/ENGINE_NOT_CONFIGURED
 *     (мост для 077, §5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerResponse } from '@hl/contracts';

import {
  AI_BUSY_MESSAGE_KEY,
  AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY,
  AI_WORKER_CRASHED_MESSAGE_KEY,
  LlmProcessClient,
  type LlmNotify,
  type LlmWorkerPort,
  type LlmWorkerProcess,
  type SpawnLlmWorker,
} from '../modules/ai-insight/adapters/llm-process-client.js';
import {
  notConfiguredEngine,
  startLlmWorkerLoop,
  type LlmWorkerEngine,
  type WorkerTransport,
} from './protocol.js';
import { silentLogger } from '../shared/logger/silent-logger.js';

/**
 * In-process канал «процессной границы»: макротаскичная доставка в обе стороны
 * (очередь, как реальный IPC), crash = порт мёртв + exit у main-стороны.
 */
class InProcessWorkerChannel {
  private dead = false;
  private readonly clientListeners = new Set<(message: WorkerResponse) => void>();
  private workerListener: ((raw: unknown) => void) | undefined;
  private readonly exitListeners = new Set<(code: number) => void>();

  /** Сторона клиента (LlmWorkerPort). */
  readonly clientPort: LlmWorkerPort = {
    postMessage: (message) => {
      if (this.dead) {
        return; // мёртвый порт молчит — клиент узнает по exit (§9)
      }
      setTimeout(() => {
        this.workerListener?.(message);
      }, 0);
    },
    onMessage: (listener) => {
      this.clientListeners.add(listener);
    },
    start: () => undefined,
    close: () => {
      this.dead = true;
    },
  };

  /** Сторона воркера (WorkerTransport для startLlmWorkerLoop). */
  readonly workerTransport: WorkerTransport = {
    postMessage: (message) => {
      if (this.dead) {
        return;
      }
      setTimeout(() => {
        for (const listener of [...this.clientListeners]) {
          listener(message);
        }
      }, 0);
    },
    onRequest: (listener) => {
      // Протокол 076 §7: raw запроса — всегда WorkerRequest; хранилище — unknown-сигнатура.
      this.workerListener = listener as (raw: unknown) => void;
    },
  };

  /** main-сторона процесса (LlmWorkerProcess). */
  readonly process: LlmWorkerProcess = {
    port: this.clientPort,
    onExit: (listener) => {
      this.exitListeners.add(listener);
    },
    kill: () => {
      this.crash(0);
    },
  };

  /** Симуляция краша нативного кода: порт умирает, main видит exit. */
  crash(code = 1): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    for (const listener of [...this.exitListeners]) {
      listener(code);
    }
  }
}

/** Опции echo-движка. */
interface EchoEngineOptions {
  readonly tokenDelayMs?: number;
  /** Задержка выгрузки (окно «unload в полёте» для краша, ревью TASK-076). */
  readonly unloadDelayMs?: number;
  /** Хук краша «процесса» (передаётся каналу — нативный сбой, §19). */
  readonly onCrash?: () => void;
}

/**
 * Echo-движок (§19 «стримит N токенов»): N = maxTokens запроса, формат
 * «токен-<i> », отмена кооперативная — поток останавливается, done(cancelled).
 * §5 env-хук HL_FAKE_WORKER_CRASH=1: первая же complete крашит воркер (one-shot —
 * флаг снимается, чтобы «следующая генерация успешна» прошла, §20 AC2).
 */
function createEchoEngine(options: EchoEngineOptions = {}): LlmWorkerEngine {
  const cancelled = new Set<string>();
  return {
    load: () => Promise.resolve(),
    unload: () =>
      options.unloadDelayMs === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => setTimeout(resolve, options.unloadDelayMs)),
    complete: (request, emit) => {
      if (process.env['HL_FAKE_WORKER_CRASH'] === '1') {
        delete process.env['HL_FAKE_WORKER_CRASH'];
        options.onCrash?.();
        return new Promise<'stop' | 'cancelled'>(() => undefined); // воркер мёртв
      }
      const total = request.maxTokens;
      let sent = 0;
      return new Promise<'stop' | 'cancelled'>((resolve) => {
        const step = (): void => {
          if (cancelled.has(request.requestId)) {
            resolve('cancelled');
            return;
          }
          if (sent >= total) {
            resolve('stop');
            return;
          }
          emit(`токен-${sent} `);
          sent += 1;
          setTimeout(step, options.tokenDelayMs ?? 2);
        };
        setTimeout(step, options.tokenDelayMs ?? 2);
      });
    },
    cancel: (requestId) => {
      cancelled.add(requestId);
    },
  };
}

/** Сборщик событий notify (ai:status/ai:token). */
function collectingNotify(): {
  notify: LlmNotify;
  events: Array<{ name: string; payload: unknown }>;
} {
  const events: Array<{ name: string; payload: unknown }> = [];
  const notify: LlmNotify = (name, payload) => {
    events.push({ name, payload });
  };
  return { notify, events };
}

/**
 * Клиент над in-process воркерами с БОЕВЫМ циклом; backoff/flush — тестовые.
 * Фабрика движка получает хук краша СВОЕГО канала (краш «убивает» процесс —
 * порт мёртв + exit, как с настоящим UtilityProcess). Каналы отдаются тесту —
 * для краша вне движка (ревью TASK-076: unload в полёте + queued load).
 */
function newClient(
  engineFactory: (crash: () => void) => LlmWorkerEngine,
  notify: LlmNotify,
): { client: LlmProcessClient; channels: InProcessWorkerChannel[] } {
  const channels: InProcessWorkerChannel[] = [];
  const spawn: SpawnLlmWorker = () => {
    const channel = new InProcessWorkerChannel();
    channels.push(channel);
    startLlmWorkerLoop(
      channel.workerTransport,
      engineFactory(() => channel.crash(1)),
    );
    return channel.process;
  };
  const client = new LlmProcessClient({
    spawn,
    notify,
    pathExists: () => true,
    restartBackoffMs: 5,
    tokenFlushMs: 10,
    idleTimeoutMs: 10_000,
    logger: silentLogger(),
  });
  return { client, channels };
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const COMPLETE = {
  messages: [{ role: 'user', content: 'резюме периода' } as const],
  maxTokens: 10,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('llm-worker.int — полный цикл протокола (§19/§20 AC1)', () => {
  it('load → complete → стрим 10 токенов пачками → done(stop)', async () => {
    const { notify, events } = collectingNotify();
    const { client } = newClient((crash) => createEchoEngine({ onCrash: crash }), notify);

    await expect(client.load('test://model.gguf')).resolves.toBeUndefined();

    const batches: string[] = [];
    const result = await client.complete('req-1', COMPLETE, {
      onToken: (text) => batches.push(text),
    });

    expect(result).toEqual({ finishReason: 'stop' });
    const expected = Array.from({ length: 10 }, (_, index) => `токен-${index} `).join('');
    // Токены доставлены целиком и ПАЧКАМИ (10 delta → меньше 10 доставок, §11).
    expect(batches.join('')).toBe(expected);
    expect(batches.length).toBeLessThan(10);

    const tokenEvents = events.filter((event) => event.name === 'ai:token');
    expect(tokenEvents.map((event) => (event.payload as { text: string }).text).join('')).toBe(
      expected,
    );
    const statuses = events
      .filter((event) => event.name === 'ai:status')
      .map((event) => event.payload as { state: string; requestId?: string });
    expect(statuses).toEqual([
      { state: 'starting' },
      { state: 'ready' },
      { state: 'busy', requestId: 'req-1' },
      { state: 'ready', requestId: 'req-1' },
    ]);
    expect(client.state).toBe('ready');
  });

  it('боевой каркас без движка: load/complete → AI/ENGINE_NOT_CONFIGURED (§5 мост для 077)', async () => {
    const { client } = newClient(() => notConfiguredEngine, collectingNotify().notify);
    await expect(client.load('test://model.gguf')).rejects.toMatchObject({
      code: 'AI/ENGINE_NOT_CONFIGURED',
      messageKey: AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY,
    });
    await expect(client.complete('req-1', COMPLETE)).rejects.toMatchObject({
      code: 'AI/ENGINE_NOT_CONFIGURED',
      messageKey: AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY,
    });
  });
});

describe('llm-worker.int — cancel и BUSY (§19/§20 AC4/AC5)', () => {
  it('cancel посреди: поток останавливается, done(cancelled), после отмены токенов нет', async () => {
    const { client } = newClient(
      (crash) => createEchoEngine({ tokenDelayMs: 15, onCrash: crash }),
      collectingNotify().notify,
    );

    await client.load('test://model.gguf');
    const tokens: string[] = [];
    const generating = client.complete('req-1', COMPLETE, {
      onToken: (text) => tokens.push(text),
    });
    await sleep(60); // несколько токенов ушли
    client.cancel('req-1');

    await expect(generating).resolves.toEqual({ finishReason: 'cancelled' });
    const lengthAtCancel = tokens.join('').length;
    await sleep(120);
    expect(tokens.join('').length).toBe(lengthAtCancel); // поток остановлен
  });

  it('BUSY на второй параллельной генерации (код AI/BUSY); первая завершается штатно', async () => {
    const { client } = newClient(
      (crash) => createEchoEngine({ tokenDelayMs: 10, onCrash: crash }),
      collectingNotify().notify,
    );
    await client.load('test://model.gguf');

    const first = client.complete('req-1', COMPLETE);
    await expect(client.complete('req-2', COMPLETE)).rejects.toMatchObject({
      code: 'AI/BUSY',
      messageKey: AI_BUSY_MESSAGE_KEY,
    });
    await expect(first).resolves.toEqual({ finishReason: 'stop' });

    // Слот освободился — следующая генерация принимается.
    await expect(client.complete('req-3', COMPLETE)).resolves.toEqual({ finishReason: 'stop' });
  });

  it('unload при активной генерации → AI/BUSY; после done — выгружается', async () => {
    const { client } = newClient(
      (crash) => createEchoEngine({ tokenDelayMs: 10, onCrash: crash }),
      collectingNotify().notify,
    );
    await client.load('test://model.gguf');

    const generating = client.complete('req-1', COMPLETE);
    await expect(client.unload()).rejects.toMatchObject({ code: 'AI/BUSY' });
    await expect(generating).resolves.toEqual({ finishReason: 'stop' });
    await expect(client.unload()).resolves.toBeUndefined();
  });
});

describe('llm-worker.int — краш и восстановление (§19/§20 AC2, env-хук §5)', () => {
  it('краш во время генерации (HL_FAKE_WORKER_CRASH): отклонение requestId, перезапуск + авто-reload, следующая генерация успешна', async () => {
    vi.stubEnv('HL_FAKE_WORKER_CRASH', '1');
    const { notify, events } = collectingNotify();
    const { client } = newClient((crash) => createEchoEngine({ onCrash: crash }), notify);

    await client.load('test://model.gguf');

    // Хендлер отклонения вешаем ДО краша — иначе vitest увидит unhandled rejection.
    const generating = client.complete('req-1', COMPLETE);
    const expectation = expect(generating).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
      messageKey: AI_WORKER_CRASHED_MESSAGE_KEY,
    });
    await sleep(50);
    await expectation;

    // Перезапуск (backoff 5 мс) + авто-reload загруженной модели (§13).
    await sleep(40);
    expect(client.state).toBe('ready');

    // env-хук one-shot снят упавшей генерацией — новая генерация успешна (§20 AC2).
    const batches: string[] = [];
    await expect(
      client.complete('req-2', COMPLETE, { onToken: (text) => batches.push(text) }),
    ).resolves.toEqual({ finishReason: 'stop' });
    expect(batches.join('')).toContain('токен-9');

    const statuses = events
      .filter((event) => event.name === 'ai:status')
      .map((event) => event.payload as { state: string; requestId?: string });
    expect(statuses).toContainEqual({ state: 'restarting', requestId: 'req-1' });
  });

  it('краш после успешной генерации: перезапуск восстанавливает модель, генерация работает', async () => {
    const { notify, events } = collectingNotify();
    const { client } = newClient((crash) => createEchoEngine({ onCrash: crash }), notify);
    await client.load('test://model.gguf');
    await expect(client.complete('req-1', COMPLETE)).resolves.toEqual({ finishReason: 'stop' });

    vi.stubEnv('HL_FAKE_WORKER_CRASH', '1');
    const failing = client.complete('req-2', COMPLETE);
    const expectation = expect(failing).rejects.toMatchObject({ code: 'AI/WORKER_CRASHED' });
    await sleep(50);
    await expectation;
    await sleep(40);
    expect(client.state).toBe('ready');

    vi.unstubAllEnvs();
    await expect(client.complete('req-3', COMPLETE)).resolves.toEqual({ finishReason: 'stop' });
    const statuses = events
      .filter((event) => event.name === 'ai:status')
      .map((event) => (event.payload as { state: string }).state);
    expect(statuses).toContain('restarting');
  });
});

describe('llm-worker.int — queued-операции при краше (ревью TASK-076, §7/§13/§23)', () => {
  it('краш во время unload с queued load: unload → WORKER_CRASHED, queued load дожидается перезапуска и проходит (каскад не зависает)', async () => {
    const { client, channels } = newClient(
      (crash) => createEchoEngine({ unloadDelayMs: 40, onCrash: crash }),
      collectingNotify().notify,
    );

    await client.load('test://model-m1.gguf');

    // unload в полёте (движок держит его 40 мс), queued load за ним (§23).
    const unloading = client.unload();
    await sleep(5); // unload ушёл воркеру
    const unloadingExpectation = expect(unloading).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
      messageKey: AI_WORKER_CRASHED_MESSAGE_KEY,
    });
    const loading2 = client.load('test://model-m2.gguf');
    await sleep(5); // m2 дошёл до очереди и залег на слоте unload'а (while pendingCall)

    channels[0]?.crash(1); // краш процесса при незавершённом unload — ровно окно ревью
    await unloadingExpectation; // unload получил терминальное состояние (§7)

    // Перезапуск (backoff 5 мс) + авто-reload m1, затем queued load уходит новому воркеру.
    await sleep(60);
    expect(client.state).toBe('ready');
    await expect(loading2).resolves.toBeUndefined();
  });
});
