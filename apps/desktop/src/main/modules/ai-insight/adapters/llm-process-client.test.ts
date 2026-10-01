/**
 * TASK-076 §5/§13/§20/§22: юнит-тесты main-side клиента LlmProcessClient на
 * мок-порте/мок-spawn (fake-воркер-скрипт отвечает вручную; РЕАЛЬНЫЙ цикл воркера
 * проходит в llm-worker.int.test.ts).
 *
 * Матрица:
 *  - ленивый spawn + handshake (≤1 процесс на серию операций), статусы ai:status;
 *  - §14: путь модели валидируется существованием ДО передачи (AI/MODEL_NOT_FOUND,
 *    без spawn);
 *  - §11/§20: токены батчатся (flush 50 мс: пачка ≤50 мс группирует быструю
 *    последовательность; редкие токены — отдельные пачки), done дочищает буфер ДО
 *    резолва; доставка ai:token;
 *  - §9: вторая параллельная генерация → AI/BUSY, сообщение воркеру не уходит;
 *  - адресный error воркера → AppError по карте (ENGINE_NOT_CONFIGURED →
 *    AI/ENGINE_NOT_CONFIGURED, неизвестный код → APP/INTERNAL с params.code);
 *  - §13: cancel идемпотентен (повтор/незнакомый/после done — сообщений нет),
 *    done(cancelled) резолвит генерацию;
 *  - §20: краш → активный requestId отклонён AI/WORKER_CRASHED, автоперезапуск
 *    (backoff), авто-reload загруженной модели, следующая генерация работает;
 *    исчерпание попыток → ai:status failed, перезапусков без операций нет;
 *  - §22: watchdog — генерация без токенов/done дольше idleTimeoutMs → kill,
 *    отклонение, перезапуск;
 *  - dispose: активное отклоняется, процессов больше не создаётся.
 */
import { describe, expect, it } from 'vitest';

import type { WorkerRequest, WorkerResponse } from '@hl/contracts';

import {
  AI_BUSY_MESSAGE_KEY,
  AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY,
  AI_MODEL_NOT_FOUND_MESSAGE_KEY,
  AI_WORKER_CRASHED_MESSAGE_KEY,
  LlmProcessClient,
  type LlmNotify,
  type LlmWorkerPort,
  type LlmWorkerProcess,
  type SpawnLlmWorker,
} from './llm-process-client.js';

/** Мок порта: исходящие к воркеру собираются, от воркера — через fromWorker(). */
class FakePort implements LlmWorkerPort {
  readonly sentToWorker: WorkerRequest[] = [];
  closed = false;
  /** Следующий postMessage бросит (порт мёртв, exit ещё не дошёл — ревью TASK-076). */
  failNextPost = false;
  private readonly listeners = new Set<(message: WorkerResponse) => void>();

  postMessage(message: WorkerRequest): void {
    if (this.failNextPost) {
      this.failNextPost = false;
      throw new Error('порт закрыт (postMessage failed)');
    }
    this.sentToWorker.push(message);
  }

  onMessage(listener: (message: WorkerResponse) => void): void {
    this.listeners.add(listener);
  }

  start(): void {
    // транспорт-нейтрально: Electron-порт требует start(), мок — нет
  }

  close(): void {
    this.closed = true;
  }

  /** Тест пинает сообщение «от воркера». */
  fromWorker(message: WorkerResponse): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

/** Мок процесса воркера: exit-подписки, kill/crash симуляция. */
class FakeProcess implements LlmWorkerProcess {
  readonly port = new FakePort();
  killed = false;
  private readonly exitListeners = new Set<(code: number) => void>();

  onExit(listener: (code: number) => void): void {
    this.exitListeners.add(listener);
  }

  kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    for (const listener of [...this.exitListeners]) {
      listener(0);
    }
  }

  /** Тест крашит процесс (порт закрывается, main видит exit). */
  crash(code = 1): void {
    this.port.close();
    for (const listener of [...this.exitListeners]) {
      listener(code);
    }
  }
}

interface SpawnRecord {
  readonly process: FakeProcess;
  readonly entryPath: string;
}

/** Фабрика мок-spawn: каждый вызов — запись; бросающий — по флагу. */
function fakeSpawn(options?: { throwOnCall?: Error }): {
  spawn: SpawnLlmWorker;
  records: SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  const spawn: SpawnLlmWorker = (entryPath) => {
    if (options?.throwOnCall !== undefined) {
      throw options.throwOnCall;
    }
    const process = new FakeProcess();
    records.push({ process, entryPath });
    return process;
  };
  return { spawn, records };
}

/** Автоответчик простого фейк-воркера: load→ready, unload→unloaded; остальное — хук теста. */
function respondPending(
  port: FakePort,
  state: { answered: number },
  onUnmatched?: (request: WorkerRequest) => void,
): void {
  while (state.answered < port.sentToWorker.length) {
    const request = port.sentToWorker[state.answered]!;
    state.answered += 1;
    if (request.type === 'load') {
      port.fromWorker({ type: 'ready' });
    } else if (request.type === 'unload') {
      port.fromWorker({ type: 'unloaded' });
    } else {
      onUnmatched?.(request);
    }
  }
}

/** Прогон микротасков, чтобы async-цепочки клиента разошлись. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

const COMPLETE_REQUEST = {
  messages: [{ role: 'user', content: 'сделай резюме' } as const],
  maxTokens: 16,
};

/** Клиент под юнит-тесты: мгновенный backoff, маленький flush. */
function newClient(
  spawn: SpawnLlmWorker,
  notify: LlmNotify,
  options: { flushMs?: number; backoffMs?: number; maxRestarts?: number; idleMs?: number } = {},
): LlmProcessClient {
  return new LlmProcessClient({
    spawn,
    notify,
    pathExists: () => true,
    restartBackoffMs: options.backoffMs ?? 1,
    tokenFlushMs: options.flushMs ?? 5,
    idleTimeoutMs: options.idleMs ?? 10_000,
    maxRestartAttempts: options.maxRestarts ?? 3,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

describe('LlmProcessClient — spawn/handshake/статусы (§5/§15)', () => {
  it('первая операция спавнит воркер ровно один раз; ai:status starting→ready', async () => {
    const { spawn, records } = fakeSpawn();
    const { notify, events } = collectingNotify();
    const client = newClient(spawn, notify);

    const loading = client.load('C:/models/m.gguf');
    await tick();
    expect(records).toHaveLength(1);
    expect(records[0]?.process.port.sentToWorker).toEqual([
      { type: 'load', modelPath: 'C:/models/m.gguf' },
    ]);

    records[0]?.process.port.fromWorker({ type: 'ready' });
    await expect(loading).resolves.toBeUndefined();

    // Вторая операция не спавнит новый процесс.
    const loading2 = client.load('C:/models/m2.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 1 });
    await expect(loading2).resolves.toBeUndefined();
    expect(records).toHaveLength(1);

    const statuses = events.filter((event) => event.name === 'ai:status');
    expect(statuses.map((event) => (event.payload as { state: string }).state)).toEqual([
      'starting',
      'ready',
    ]);
  });

  it('§14: несуществующий путь модели → AI/MODEL_NOT_FOUND, spawn НЕ вызывался', async () => {
    const { spawn, records } = fakeSpawn();
    const client = new LlmProcessClient({
      spawn,
      pathExists: () => false,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await expect(client.load('C:/models/нет.gguf')).rejects.toMatchObject({
      code: 'AI/MODEL_NOT_FOUND',
      messageKey: AI_MODEL_NOT_FOUND_MESSAGE_KEY,
    });
    expect(records).toHaveLength(0);
  });

  it('отказ spawn-фабрики → честный отказ операции (APP/INTERNAL), без цикла перезапусков', async () => {
    let spawnCalls = 0;
    const spawn: SpawnLlmWorker = () => {
      spawnCalls += 1;
      throw new Error('utilityProcess недоступен');
    };
    const client = newClient(spawn, collectingNotify().notify);

    await expect(client.load('C:/m.gguf')).rejects.toMatchObject({ code: 'APP/INTERNAL' });
    expect(spawnCalls).toBe(1); // одна попытка, не шторм
  });
});

describe('LlmProcessClient — complete: стрим, батчинг, BUSY (§9/§11/§20)', () => {
  it('токены батчатся: быстрая серия → одна пачка ≤ flush-интервала; ai:token доставлен', async () => {
    const { spawn, records } = fakeSpawn();
    const { notify, events } = collectingNotify();
    const client = newClient(spawn, notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;

    const port = records[0]?.process.port as FakePort;
    const tokens: string[] = [];
    const generating = client.complete('req-1', COMPLETE_REQUEST, {
      onToken: (text) => tokens.push(text),
    });
    await tick();

    const startedAt = Date.now();
    port.fromWorker({ type: 'token', requestId: 'req-1', delta: 'а' });
    port.fromWorker({ type: 'token', requestId: 'req-1', delta: 'б' });
    port.fromWorker({ type: 'token', requestId: 'req-1', delta: 'в' });
    port.fromWorker({ type: 'done', requestId: 'req-1', finishReason: 'stop' });
    await expect(generating).resolves.toEqual({ finishReason: 'stop' });

    // Три токена, пришедшие в один flush-интервал, — ОДНА пачка, доставленная до резолва.
    expect(tokens).toEqual(['абв']);
    // Пачка ушла в пределах flush-интервала + допуск планировщика (§20: группировка ≤50 мс).
    expect(Date.now() - startedAt).toBeLessThan(200);

    const tokenEvents = events.filter((event) => event.name === 'ai:token');
    expect(tokenEvents).toEqual([
      { name: 'ai:token', payload: { requestId: 'req-1', text: 'абв' } },
    ]);
    const statuses = events
      .filter((event) => event.name === 'ai:status')
      .map((event) => event.payload as { state: string; requestId?: string });
    expect(statuses).toEqual([
      { state: 'starting' },
      { state: 'ready' },
      { state: 'busy', requestId: 'req-1' },
      { state: 'ready', requestId: 'req-1' },
    ]);
  });

  it('токены с интервалом больше flush — отдельные пачки (граница 50 мс проверяется на таймере)', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify, { flushMs: 30 });
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;

    const port = records[0]?.process.port as FakePort;
    const batches: string[] = [];
    const generating = client.complete('req-1', COMPLETE_REQUEST, {
      onToken: (text) => batches.push(text),
    });
    await tick();

    port.fromWorker({ type: 'token', requestId: 'req-1', delta: '1' });
    await sleep(10); // внутри flush-окна
    port.fromWorker({ type: 'token', requestId: 'req-1', delta: '2' });
    await sleep(60); // окно истекло — пачка «12» ушла
    port.fromWorker({ type: 'token', requestId: 'req-1', delta: '3' });
    port.fromWorker({ type: 'done', requestId: 'req-1', finishReason: 'stop' });
    await generating;

    expect(batches).toEqual(['12', '3']);
  });

  it('вторая параллельная генерация → AI/BUSY, запрос воркеру не уходит (§9)', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const port = records[0]?.process.port as FakePort;

    const first = client.complete('req-1', COMPLETE_REQUEST);
    await tick();
    const sentBefore = port.sentToWorker.length;

    await expect(client.complete('req-2', COMPLETE_REQUEST)).rejects.toMatchObject({
      code: 'AI/BUSY',
      messageKey: AI_BUSY_MESSAGE_KEY,
    });
    expect(port.sentToWorker.length).toBe(sentBefore); // второй complete воркеру не писали

    port.fromWorker({ type: 'done', requestId: 'req-1', finishReason: 'stop' });
    await first;
  });

  it('адресный error воркера → AppError по карте; неизвестный код → APP/INTERNAL с params.code', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const port = records[0]?.process.port as FakePort;

    const notConfigured = client.complete('req-1', COMPLETE_REQUEST);
    await tick();
    port.fromWorker({ type: 'error', requestId: 'req-1', code: 'ENGINE_NOT_CONFIGURED' });
    await expect(notConfigured).rejects.toMatchObject({
      code: 'AI/ENGINE_NOT_CONFIGURED',
      messageKey: AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY,
    });

    const boom = client.complete('req-2', COMPLETE_REQUEST);
    await tick();
    port.fromWorker({ type: 'error', requestId: 'req-2', code: 'ENGINE_WEIRD' });
    await expect(boom).rejects.toMatchObject({
      code: 'APP/INTERNAL',
      params: { code: 'ENGINE_WEIRD' },
    });
  });

  it('мусор канала (guard контракта) не диспетчеризуется и не валит клиент (§14)', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const port = records[0]?.process.port as FakePort;

    port.fromWorker('мусор' as unknown as WorkerResponse);
    port.fromWorker({ type: 'token', requestId: 'ни-разу-не-был', delta: 'x' }); // не в реестре — игнор
    port.fromWorker({ type: 'error', requestId: 'ни-разу-не-был', code: 'BUSY' });

    expect(client.state).toBe('ready');
  });
});

describe('LlmProcessClient — cancel/unload (§13/§20)', () => {
  it('cancel идемпотентен: незнакомый/повторный/после done — сообщений нет; активный уходит один раз', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const port = records[0]?.process.port as FakePort;

    client.cancel('нет-такой');
    expect(port.sentToWorker.filter((request) => request.type === 'cancel')).toHaveLength(0);

    const generating = client.complete('req-1', COMPLETE_REQUEST);
    await tick();
    client.cancel('req-1');
    client.cancel('req-1'); // повтор — дедуплицирован
    expect(port.sentToWorker.filter((request) => request.type === 'cancel')).toEqual([
      { type: 'cancel', requestId: 'req-1' },
    ]);

    port.fromWorker({ type: 'done', requestId: 'req-1', finishReason: 'cancelled' });
    await expect(generating).resolves.toEqual({ finishReason: 'cancelled' });

    client.cancel('req-1'); // после done — no-op (§9)
    expect(port.sentToWorker.filter((request) => request.type === 'cancel')).toHaveLength(1);
  });

  it('unload при активной генерации → AI/BUSY, воркеру не пишем; при простое — unloaded', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const port = records[0]?.process.port as FakePort;

    const generating = client.complete('req-1', COMPLETE_REQUEST);
    await tick();
    await expect(client.unload()).rejects.toMatchObject({ code: 'AI/BUSY' });
    expect(port.sentToWorker.filter((request) => request.type === 'unload')).toHaveLength(0);

    port.fromWorker({ type: 'done', requestId: 'req-1', finishReason: 'stop' });
    await generating;

    const unloading = client.unload();
    await tick();
    expect(port.sentToWorker.at(-1)).toEqual({ type: 'unload' });
    port.fromWorker({ type: 'unloaded' });
    await expect(unloading).resolves.toBeUndefined();
  });
});

describe('LlmProcessClient — краш и автоперезапуск (§13/§20/§22)', () => {
  it('краш во время генерации: отклонение AI/WORKER_CRASHED, ai:status restarting (с requestId), перезапуск, авто-reload, новая генерация работает', async () => {
    const { spawn, records } = fakeSpawn();
    const { notify, events } = collectingNotify();
    const client = newClient(spawn, notify);
    const loaded = client.load('C:/models/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const port = records[0]?.process.port as FakePort;

    const generating = client.complete('req-1', COMPLETE_REQUEST);
    await tick();
    port.fromWorker({ type: 'token', requestId: 'req-1', delta: 'часть' });
    await tick();

    records[0]?.process.crash(1);
    await expect(generating).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
      messageKey: AI_WORKER_CRASHED_MESSAGE_KEY,
    });

    // После backoff перезапуск + авто-reload загруженной модели.
    await tick();
    await sleep(20);
    expect(records).toHaveLength(2);
    const port2 = records[1]?.process.port as FakePort;
    const state = { answered: 0 };
    // Новый воркер сам присылает startup-ready и отвечает ready на авто-reload.
    respondPending(port2, state);
    port2.fromWorker({ type: 'ready' });
    await tick();
    expect(port2.sentToWorker).toEqual([{ type: 'load', modelPath: 'C:/models/m.gguf' }]);
    await tick();
    respondPending(port2, state);
    await tick();

    const statuses = events
      .filter((event) => event.name === 'ai:status')
      .map((event) => event.payload as { state: string; requestId?: string });
    expect(statuses).toContainEqual({ state: 'restarting', requestId: 'req-1' });

    // Новая генерация работает.
    const second = client.complete('req-2', COMPLETE_REQUEST);
    await tick();
    respondPending(port2, state, (request) => {
      if (request.type === 'complete') {
        port2.fromWorker({ type: 'done', requestId: request.requestId, finishReason: 'stop' });
      }
    });
    await tick();
    await expect(second).resolves.toEqual({ finishReason: 'stop' });
  });

  it('исчерпание попыток: ai:status failed, спавнов без новых операций больше нет', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify, { maxRestarts: 2 });

    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;

    // Каждый перезапущенный воркер крашится немедленно (после ack авто-reload).
    records[0]?.process.crash(1);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await sleep(10);
      const latest = records.at(-1)?.process;
      if (latest !== undefined && latest !== records[0]?.process) {
        latest.port.fromWorker({ type: 'ready' }); // ack авто-reload → гейт закрыт
        latest.crash(1);
      }
      if (client.state === 'failed') {
        break;
      }
    }
    expect(client.state).toBe('failed');

    const countAtFailure = records.length;
    await sleep(30);
    expect(records).toHaveLength(countAtFailure); // перезапусков без операций нет

    // Новая операция после failed — полная новая попытка (свежий цикл перезапусков).
    const reload = client.load('C:/m.gguf');
    await sleep(10);
    expect(records.length).toBeGreaterThan(countAtFailure);
    const latest = records.at(-1)?.process.port as FakePort;
    latest.fromWorker({ type: 'ready' }); // ack авто-reload — гейт готовности
    await tick();
    latest.fromWorker({ type: 'ready' }); // ack пользовательского load
    await expect(reload).resolves.toBeUndefined();
  });

  it('§22: генерация без токенов/done дольше idleTimeoutMs → kill, отклонение WORKER_CRASHED, перезапуск', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify, { idleMs: 40 });

    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;
    const first = records[0]?.process as FakeProcess;

    // Хендлер отклонения вешаем ДО срабатывания watchdog — иначе vitest увидит
    // unhandled rejection в момент таймера (§22-тест не про это).
    const generating = client.complete('req-1', COMPLETE_REQUEST);
    const expectation = expect(generating).rejects.toMatchObject({ code: 'AI/WORKER_CRASHED' });
    await sleep(120);
    await expectation;

    expect(first.killed).toBe(true);
    expect(records.length).toBeGreaterThanOrEqual(2); // watchdog-перезапуск случился

    // Новый воркер получил авто-reload загруженной модели; ack закрывает гейт.
    const port2 = records[1]?.process.port as FakePort;
    expect(port2.sentToWorker).toEqual([{ type: 'load', modelPath: 'C:/m.gguf' }]);
    port2.fromWorker({ type: 'ready' });
    await tick();
    expect(client.state).toBe('ready');
  });

  it('dispose: активная генерация отклоняется, процесс убит, нового спавна нет', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded = client.load('C:/m.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded;

    const generating = client.complete('req-1', COMPLETE_REQUEST);
    await tick();
    client.dispose();
    await expect(generating).rejects.toMatchObject({ code: 'APP/INTERNAL' });
    expect(records[0]?.process.killed).toBe(true);

    const countAtDispose = records.length;
    await sleep(20);
    expect(records).toHaveLength(countAtDispose);
    await expect(client.load('C:/m.gguf')).rejects.toMatchObject({ code: 'APP/INTERNAL' });
  });
});

describe('LlmProcessClient — queued-операции при краше (ревью TASK-076: терминальность §7)', () => {
  it('краш во время unload с queued load: unload отклонён WORKER_CRASHED, queued load дожидается перезапуска и проходит (не висит)', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded1 = client.load('C:/m1.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded1;

    // unload в полёте (ack НЕ отсылаем), за ним queued load (§23: unload+load).
    const unloading = client.unload();
    await tick();
    const unloadingExpectation = expect(unloading).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
      messageKey: AI_WORKER_CRASHED_MESSAGE_KEY,
    });
    const loading2 = client.load('C:/m2.gguf'); // встал в очередь за unload
    await tick();

    records[0]?.process.crash(1);
    await unloadingExpectation; // unload получил терминальное состояние (§7)

    // Перезапуск + авто-reload m1 (unload не успел завершиться — модель осталась).
    await sleep(20);
    expect(records).toHaveLength(2);
    const port2 = records[1]?.process.port as FakePort;
    port2.fromWorker({ type: 'ready' }); // ack авто-reload — гейт готовности
    await tick();
    await tick();

    // QUEUED load дожил: ушёл НОВОМУ воркеру и разрешается (раньше — вечный pending:
    // send() глотал при alive === undefined, слот затирался авто-reload'ом).
    expect(port2.sentToWorker).toEqual([
      { type: 'load', modelPath: 'C:/m1.gguf' }, // авто-reload
      { type: 'load', modelPath: 'C:/m2.gguf' }, // queued load
    ]);
    port2.fromWorker({ type: 'ready' }); // ack m2
    await expect(loading2).resolves.toBeUndefined();
  });

  it('краш во время queued load за load: второй дожидается перезапуска и уходит новому воркеру', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded1 = client.load('C:/m1.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded1;

    // load m2 в полёте (ack не отсылаем), load m3 — в очереди.
    const loading2 = client.load('C:/m2.gguf');
    await tick();
    const loading2Expectation = expect(loading2).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
    });
    const loading3 = client.load('C:/m3.gguf');
    await tick();

    records[0]?.process.crash(1);
    await loading2Expectation;

    await sleep(20);
    const port2 = records[1]?.process.port as FakePort;
    port2.fromWorker({ type: 'ready' }); // ack авто-reload m1
    await tick();
    await tick();
    // m3 дожил в очереди и уходит новому воркеру.
    expect(port2.sentToWorker.at(-1)).toEqual({ type: 'load', modelPath: 'C:/m3.gguf' });
    port2.fromWorker({ type: 'ready' });
    await expect(loading3).resolves.toBeUndefined();
  });

  it('отказ доставки load (мёртвый порт без exit) — терминальный отказ, не вечный pending', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify);
    const loaded1 = client.load('C:/m1.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded1;
    const port1 = records[0]?.process.port as FakePort;

    port1.failNextPost = true; // send() не доставит: операция обязана завершиться (§7)
    await expect(client.load('C:/m2.gguf')).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
    });
  });

  it('отказ доставки complete — терминальный отказ без ожидания watchdog (§7)', async () => {
    const { spawn, records } = fakeSpawn();
    const client = newClient(spawn, collectingNotify().notify, { idleMs: 10_000 });
    const loaded1 = client.load('C:/m1.gguf');
    await tick();
    respondPending(records[0]?.process.port as FakePort, { answered: 0 });
    await loaded1;
    const port1 = records[0]?.process.port as FakePort;

    port1.failNextPost = true;
    const generating = client.complete('req-1', COMPLETE_REQUEST);
    // Раньше: генерация висела бы до watchdog (10 с) или вечно — теперь сразу отказ.
    await expect(generating).rejects.toMatchObject({
      code: 'AI/WORKER_CRASHED',
      messageKey: AI_WORKER_CRASHED_MESSAGE_KEY,
    });
    // Слот освободился — следующая генерация принимается.
    const second = client.complete('req-2', COMPLETE_REQUEST);
    await tick();
    port1.fromWorker({ type: 'done', requestId: 'req-2', finishReason: 'stop' });
    await expect(second).resolves.toEqual({ finishReason: 'stop' });
  });
});
