/**
 * TASK-076 §13/§19: юнит-тесты цикла сообщений воркера (llm-worker/protocol.ts)
 * на транспорте-фейке: реестр активных генераций, BUSY на вторую parallel-генерацию,
 * load/unload при активной генерации отклоняются, cancel идемпотентен (незнакомый
 * requestId — тихий игнор), guard протокола глушит мусор канала, заглушка движка
 * (engine: not-configured) — мост для TASK-077: её отказ уходит наружу кодом
 * ENGINE_NOT_CONFIGURED.
 *
 * Интеграционная матрица §19 (полный цикл клиент + порт + воркер) — в
 * llm-worker.int.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { LlmFinishReason, WorkerRequest, WorkerResponse } from '@hl/contracts';

import {
  EngineError,
  WORKER_ERROR,
  notConfiguredEngine,
  startLlmWorkerLoop,
  type LlmWorkerEngine,
  type WorkerTransport,
} from './protocol.js';

/** Транспорт-фейк: запросы подаёт тест (сырыми), исходящие ответы собираются в журнал. */
class FakeTransport implements WorkerTransport {
  readonly sent: WorkerResponse[] = [];
  private listener: ((request: WorkerRequest) => void) | undefined;

  onRequest(listener: (request: WorkerRequest) => void): void {
    this.listener = listener;
  }

  postMessage(message: WorkerResponse): void {
    this.sent.push(message);
  }

  /** Симуляция сырого сообщения от main — цикл обязан сам прогнать его через guard §14. */
  receive(raw: unknown): void {
    this.listener?.(raw as WorkerRequest);
  }
}

/**
 * Управляемый движок: генерации «висят», пока тест не завершит их через
 * emit/finish; отказ load и стримящий complete задаются хуками.
 */
class ScriptedEngine implements LlmWorkerEngine {
  readonly active = new Map<
    string,
    { emit: (delta: string) => void; finish: (reason: LlmFinishReason) => void }
  >();
  loadedPaths: string[] = [];
  unloadCalls = 0;
  cancelCalls: string[] = [];
  loadError: EngineError | undefined;
  /** Задан — complete идёт через него (стрим/отказ); иначе — управляемый promise. */
  onCompleteHook:
    | ((requestId: string, emit: (delta: string) => void) => Promise<LlmFinishReason>)
    | undefined;

  load(modelPath: string): Promise<void> {
    this.loadedPaths.push(modelPath);
    return this.loadError !== undefined
      ? Promise.reject(this.loadError)
      : Promise.resolve();
  }

  unload(): Promise<void> {
    this.unloadCalls += 1;
    return Promise.resolve();
  }

  complete(
    request: { readonly requestId: string },
    emit: (delta: string) => void,
  ): Promise<LlmFinishReason> {
    if (this.onCompleteHook !== undefined) {
      return this.onCompleteHook(request.requestId, emit);
    }
    return new Promise<LlmFinishReason>((resolve) => {
      this.active.set(request.requestId, {
        emit,
        finish: (reason) => {
          this.active.delete(request.requestId);
          resolve(reason);
        },
      });
    });
  }

  cancel(requestId: string): void {
    this.cancelCalls.push(requestId);
  }

  /** Хелпер теста: толчок токена в «висящую» генерацию. */
  emitDelta(requestId: string, delta: string): void {
    this.active.get(requestId)?.emit(delta);
  }

  /** Хелпер теста: завершить «висящую» генерацию. */
  finish(requestId: string, reason: LlmFinishReason): void {
    this.active.get(requestId)?.finish(reason);
  }
}

/** Простой complete-запрос теста. */
function completeRequest(requestId: string, maxTokens = 4): WorkerRequest {
  return {
    type: 'complete',
    requestId,
    messages: [{ role: 'user', content: 'вопрос' }],
    maxTokens,
  };
}

/** Макротаск: даёт разойтись async-цепочкам цикла (dispatch → engine promise → ответ). */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('startLlmWorkerLoop — load/unload (§5/§13/§23)', () => {
  it('load: движок загрузил → ready (глобальный ack); отказ движка → error без requestId', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive({ type: 'load', modelPath: 'C:/models/q4.gguf' });
    await tick();
    expect(engine.loadedPaths).toEqual(['C:/models/q4.gguf']);
    expect(transport.sent).toEqual([{ type: 'ready' }]);

    engine.loadError = new EngineError('MODEL_CORRUPT');
    transport.receive({ type: 'load', modelPath: 'C:/models/bad.gguf' });
    await tick();
    expect(transport.sent).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'MODEL_CORRUPT' },
    ]);
  });

  it('load при активной генерации → BUSY, движок не вызывается (переключение = unload+load, §23)', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive({ type: 'load', modelPath: 'C:/m1.gguf' });
    await tick();
    transport.receive(completeRequest('gen-1'));
    await tick();
    transport.receive({ type: 'load', modelPath: 'C:/m2.gguf' });
    await tick();
    await tick();

    expect(transport.sent).toEqual([{ type: 'ready' }, { type: 'error', code: WORKER_ERROR.BUSY }]);
    expect(engine.loadedPaths).toEqual(['C:/m1.gguf']);
  });

  it('unload при простое: движок выгрузил → unloaded', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive({ type: 'unload' });
    await tick();
    await tick();

    expect(engine.unloadCalls).toBe(1);
    expect(transport.sent).toEqual([{ type: 'unloaded' }]);
  });

  it('unload при активной генерации → BUSY, движок не трогается (§20)', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive(completeRequest('gen-1'));
    await tick();
    transport.receive({ type: 'unload' });
    await tick();
    await tick();

    expect(engine.unloadCalls).toBe(0);
    expect(transport.sent).toEqual([{ type: 'error', code: WORKER_ERROR.BUSY }]);
  });
});

describe('startLlmWorkerLoop — complete: стрим, BUSY, ошибки (§5/§9/§13)', () => {
  it('токены стримятся token-сообщениями, завершение — done(stop); реестр очищен', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive(completeRequest('gen-1'));
    await tick();
    engine.emitDelta('gen-1', 'ток-1 ');
    engine.emitDelta('gen-1', 'ток-2 ');
    engine.finish('gen-1', 'stop');
    await tick();

    expect(transport.sent).toEqual([
      { type: 'token', requestId: 'gen-1', delta: 'ток-1 ' },
      { type: 'token', requestId: 'gen-1', delta: 'ток-2 ' },
      { type: 'done', requestId: 'gen-1', finishReason: 'stop' },
    ]);
    expect(engine.active.size).toBe(0);
  });

  it('вторая параллельная генерация → error BUSY с её requestId, первая продолжает (§9)', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive(completeRequest('gen-1'));
    await tick();
    transport.receive(completeRequest('gen-2'));
    await tick();
    await tick();

    expect(transport.sent).toEqual([
      { type: 'error', requestId: 'gen-2', code: WORKER_ERROR.BUSY },
    ]);
    expect([...engine.active.keys()]).toEqual(['gen-1']);
  });

  it('отказ движка во время генерации → адресный error с кодом движка; слот освобождён (§13)', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    engine.onCompleteHook = () => Promise.reject(new EngineError('ENGINE_BOOM'));
    startLlmWorkerLoop(transport, engine);

    transport.receive(completeRequest('gen-1'));
    await tick();

    expect(transport.sent).toEqual([{ type: 'error', requestId: 'gen-1', code: 'ENGINE_BOOM' }]);
    // Отказ конкретной генерации не ломает воркер: следующая принимается.
    engine.onCompleteHook = undefined;
    transport.receive(completeRequest('gen-2'));
    await tick();
    expect([...engine.active.keys()]).toEqual(['gen-2']);
  });
});

describe('startLlmWorkerLoop — cancel и guard протокола (§13/§14)', () => {
  it('cancel известной генерации доходит до движка; незнакомой — тихий игнор (идемпотентность)', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive({ type: 'cancel', requestId: 'нет-такой' });
    expect(engine.cancelCalls).toEqual([]);

    transport.receive(completeRequest('gen-1'));
    await tick();
    transport.receive({ type: 'cancel', requestId: 'gen-1' });
    transport.receive({ type: 'cancel', requestId: 'gen-1' });

    expect(engine.cancelCalls).toEqual(['gen-1', 'gen-1']);
    expect(transport.sent).toEqual([]); // cancel сам по себе ответа не порождает — поток закроет done(cancelled)
  });

  it('мусор канала (guard контракта не пропустил) молча игнорируется (§14)', async () => {
    const transport = new FakeTransport();
    const engine = new ScriptedEngine();
    startLlmWorkerLoop(transport, engine);

    transport.receive(null);
    transport.receive('load');
    transport.receive({ type: 'постороннее' });
    transport.receive({ type: 'cancel' }); // нет requestId
    await tick();

    expect(engine.loadedPaths).toEqual([]);
    expect(engine.active.size).toBe(0);
    expect(engine.cancelCalls).toEqual([]);
    expect(transport.sent).toEqual([]);
  });
});

describe('notConfiguredEngine — заглушка до TASK-077 (§5 «engine: not-configured»)', () => {
  it('каждая операция завершается EngineError ENGINE_NOT_CONFIGURED', async () => {
    await expect(notConfiguredEngine.load('C:/m.gguf')).rejects.toMatchObject({
      workerErrorCode: WORKER_ERROR.ENGINE_NOT_CONFIGURED,
    });
    await expect(notConfiguredEngine.unload()).rejects.toMatchObject({
      workerErrorCode: WORKER_ERROR.ENGINE_NOT_CONFIGURED,
    });
    await expect(
      notConfiguredEngine.complete(
        { requestId: 'r1', messages: [{ role: 'user', content: 'а' }], maxTokens: 4 },
        () => undefined,
      ),
    ).rejects.toMatchObject({ workerErrorCode: WORKER_ERROR.ENGINE_NOT_CONFIGURED });
  });

  it('полный проход через цикл: complete → адресный error ENGINE_NOT_CONFIGURED (мост для 077)', async () => {
    const transport = new FakeTransport();
    startLlmWorkerLoop(transport, notConfiguredEngine);

    transport.receive(completeRequest('gen-1'));
    await tick();

    expect(transport.sent).toEqual([
      { type: 'error', requestId: 'gen-1', code: WORKER_ERROR.ENGINE_NOT_CONFIGURED },
    ]);
  });
});
