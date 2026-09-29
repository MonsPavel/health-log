/**
 * TASK-078 §5/§9: юнит-тесты ProcessLlmEngine — тонкой обёртки клиента
 * llm-worker (TASK-076) за портом LlmEngine: AsyncIterable {delta}|{done}
 * транслируется из onToken/promise клиента; abort → cancel(requestId) клиента
 * и done(cancelled); BUSY/прочие отказы клиента — первым шагом итерации
 * (контракт порта — llm-engine.ts); ensureModel идемпотентен; cancel/status —
 * отображение на клиента 076.
 *
 * Клиент подменяется структурным fake (§19): поверхность LlmEngineProcessClient —
 * публичные методы LlmProcessClient, тест.resolve генераций вручную. Реальные
 * проводки клиента (крэш, рестарт, watchdog) — тесты TASK-076; здесь — только
 * трансляция.
 */
import { describe, expect, it } from 'vitest';

import type { AiWorkerState } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type {
  LlmCompleteHandlers,
  LlmCompleteRequest,
  LlmCompleteResult,
} from './llm-process-client.js';
import { ProcessLlmEngine, type LlmEngineProcessClient } from './process-llm-engine.js';
import type { LlmEngineChunk, LlmEngineRequest } from '../application/ports/llm-engine.js';

/** Активная генерация fake-клиента: ручная проводка токенов/финала тестом. */
interface CapturedGeneration {
  readonly requestId: string;
  readonly messages: LlmCompleteRequest['messages'];
  readonly maxTokens: number;
  onToken(text: string): void;
  resolve(finishReason: LlmCompleteResult['finishReason']): void;
  reject(error: AppError): void;
}

/** Структурный fake клиента 076: load/complete/cancel/state с ручным управлением. */
class FakeProcessClient implements LlmEngineProcessClient {
  state: AiWorkerState = 'ready';
  readonly loads: string[] = [];
  loadResult: Promise<void> = Promise.resolve();
  readonly generations: CapturedGeneration[] = [];
  readonly cancels: string[] = [];

  load(modelPath: string): Promise<void> {
    this.loads.push(modelPath);
    return this.loadResult;
  }

  complete(
    requestId: string,
    request: LlmCompleteRequest,
    handlers?: LlmCompleteHandlers,
  ): Promise<LlmCompleteResult> {
    return new Promise((resolve, reject) => {
      this.generations.push({
        requestId,
        messages: request.messages,
        maxTokens: request.maxTokens,
        onToken: (text: string) => {
          handlers?.onToken?.(text);
        },
        resolve: (finishReason) => {
          resolve({ finishReason });
        },
        reject,
      });
    });
  }

  cancel(requestId: string): void {
    this.cancels.push(requestId);
  }
}

/**
 * Стартует поток БЕЗ ожидания первого чанка (в отличие от fake-движка, process-
 * обёртка выдаёт чанки только после токенов клиента): тело генератора исполняется
 * до первой приостановки — клиент вызван; разгон микротасков гарантирует это.
 */
async function startStream(stream: AsyncIterable<LlmEngineChunk>): Promise<{
  iterator: AsyncIterator<LlmEngineChunk>;
  first: Promise<IteratorResult<LlmEngineChunk>>;
}> {
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  await Promise.resolve();
  return { iterator, first };
}

/** Дочитывает итератор после уже взятого первого next(). */
async function drain(iterator: AsyncIterator<LlmEngineChunk>): Promise<LlmEngineChunk[]> {
  const chunks: LlmEngineChunk[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      return chunks;
    }
    chunks.push(next.value);
  }
}

/** Полная дочитка: первый результат + остаток (порядок чанков сохранён). */
async function finish(
  first: Promise<IteratorResult<LlmEngineChunk>>,
  iterator: AsyncIterator<LlmEngineChunk>,
): Promise<LlmEngineChunk[]> {
  const head = await first;
  const chunks: LlmEngineChunk[] = head.done === true ? [] : [head.value];
  return [...chunks, ...(await drain(iterator))];
}

/** Собирает поток целиком. */
async function collect(stream: AsyncIterable<LlmEngineChunk>): Promise<LlmEngineChunk[]> {
  const chunks: LlmEngineChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function request(signal: AbortSignal = new AbortController().signal): LlmEngineRequest {
  return { messages: [{ role: 'user', content: 'вопрос' }], signal };
}

describe('ProcessLlmEngine — трансляция complete (TASK-078 §5/§9)', () => {
  it('токены клиента идут дельтами по порядку; done(finishReason) — последним чанком', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });
    const started = await startStream(engine.complete(request()));

    // Ровно одна генерация стартовала у клиента.
    expect(client.generations).toHaveLength(1);
    const generation = client.generations[0]!;

    generation.onToken('Первый ');
    generation.onToken('второй');
    generation.resolve('stop');

    const all = await finish(started.first, started.iterator);
    expect(all).toEqual([{ delta: 'Первый ' }, { delta: 'второй' }, { done: 'stop' }]);
  });

  it('запрос переносится в клиента: messages + maxTokens (дефолт опцией переопределяем)', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client, maxTokens: 77 });
    const started = await startStream(engine.complete(request()));
    client.generations[0]!.resolve('stop');
    await finish(started.first, started.iterator);

    expect(client.generations[0]!.messages).toEqual([{ role: 'user', content: 'вопрос' }]);
    expect(client.generations[0]!.maxTokens).toBe(77);
  });

  it('отказ клиента (AI/BUSY второй генерации) — первым шагом итерации, AppError', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });
    // Первая генерация заняла слот (поток стартовал, клиент вызван).
    const first = await startStream(engine.complete(request()));

    // Вторая генерация: collect стартует тело генератора — fake-клиент
    // регистрирует generation[1]; отклоняем его промис, как BUSY-гвард клиента 076.
    const collected = collect(engine.complete(request()));
    client.generations[1]!.reject(AppError.of('AI/BUSY', 'errors.AI_BUSY'));
    await expect(collected).rejects.toMatchObject({ code: 'AI/BUSY' });

    // Дочитка первой — обёртка остаётся работоспособной.
    client.generations[0]!.resolve('stop');
    const rest = await finish(first.first, first.iterator);
    expect(rest.at(-1)).toEqual({ done: 'stop' });
  });

  it('abort посреди стрима → клиенту ушёл cancel(requestId), финал done(cancelled)', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });
    const controller = new AbortController();
    const started = await startStream(engine.complete(request(controller.signal)));

    controller.abort();
    // Сигнал доставлен клиенту cancel'ом (реальный воркер остановит стрим).
    expect(client.cancels).toEqual([client.generations[0]!.requestId]);

    // Воркер закрывает поток done(cancelled) — обёртка отдаёт его как финал.
    client.generations[0]!.resolve('cancelled');
    const rest = await finish(started.first, started.iterator);
    expect(rest.at(-1)).toEqual({ done: 'cancelled' });
  });

  it('abort ДО старта — клиент не вызывается, немедленный done(cancelled)', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });
    const controller = new AbortController();
    controller.abort();

    const chunks = await collect(engine.complete(request(controller.signal)));
    expect(chunks).toEqual([{ done: 'cancelled' }]);
    expect(client.generations).toHaveLength(0);
  });

  it('разрыв потока потребителем НЕ отменяет генерацию (контракт порта) — отмена только cancel()/signal', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });
    const started = await startStream(engine.complete(request()));

    // Разрыв на приостановке yield (после выдачи первого чанка) завершается сразу.
    client.generations[0]!.onToken('токен');
    const head = await started.first;
    expect(head.done).toBe(false);
    await started.iterator.return?.();

    // Авто-отмены нет (как у реального стрима); слот всё ещё занят — cancel() порта
    // достаёт активную генерацию.
    expect(client.cancels).toEqual([]);
    engine.cancel();
    expect(client.cancels).toEqual([client.generations[0]!.requestId]);

    // Дочистка: финал доставляется в брошенную очередь без потребителя — не бросает.
    client.generations[0]!.resolve('cancelled');
    await Promise.resolve();
  });
});

describe('ProcessLlmEngine — ensureModel/cancel/status (TASK-078 §5/§19)', () => {
  it('ensureModel делегирует load; идемпотентен (тот же id — без повторного load)', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });

    await engine.ensureModel('C:/models/gemma.gguf');
    expect(client.loads).toEqual(['C:/models/gemma.gguf']);

    // Повторный вызов с тем же id — no-op (§19).
    await engine.ensureModel('C:/models/gemma.gguf');
    expect(client.loads).toEqual(['C:/models/gemma.gguf']);

    // Другой id — загрузка уходит клиенту.
    await engine.ensureModel('C:/models/other.gguf');
    expect(client.loads).toEqual(['C:/models/gemma.gguf', 'C:/models/other.gguf']);
  });

  it('отказ load — AppError наружу; modelId не фиксируется, повтор возможен', async () => {
    const client = new FakeProcessClient();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- имитация отказа клиента 076 — AppError (не Error по построению, TASK-006)
    client.loadResult = Promise.reject(
      AppError.of('AI/MODEL_NOT_FOUND', 'errors.AI_MODEL_NOT_FOUND', { model: 'x.gguf' }),
    );
    const engine = new ProcessLlmEngine({ client });

    await expect(engine.ensureModel('C:/models/missing.gguf')).rejects.toMatchObject({
      code: 'AI/MODEL_NOT_FOUND',
    });
    expect(engine.status()).toEqual({ loaded: false, busy: false });

    // После отказа повторный ensureModel снова идёт в клиента (ретри).
    client.loadResult = Promise.resolve();
    await engine.ensureModel('C:/models/missing.gguf');
    expect(client.loads).toHaveLength(2);
    expect(engine.status().loaded).toBe(true);
  });

  it('cancel() без активной генерации — no-op; активной — cancel(requestId) клиента', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });

    expect(() => engine.cancel()).not.toThrow();
    expect(client.cancels).toEqual([]);

    const started = await startStream(engine.complete(request()));
    engine.cancel();
    expect(client.cancels).toEqual([client.generations[0]!.requestId]);

    client.generations[0]!.resolve('cancelled');
    await finish(started.first, started.iterator);

    // После завершения cancel — снова no-op (id уже не активен).
    engine.cancel();
    expect(client.cancels).toHaveLength(1);
  });

  it('BUSY-отказ второй параллельной НЕ теряет активную генерацию: cancel() порта достаёт стримящую №1 (ревью TASK-078)', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });

    // №1 стартована и стримит (поток открыт, промис клиента не завершён).
    const first = await startStream(engine.complete(request()));

    // №2 стартована и отклонена гардом клиента (AI/BUSY — штатный контракт порта,
    // llm-engine.ts §13; клиент 076 отклоняет вторую параллельную).
    const collected = collect(engine.complete(request()));
    client.generations[1]!.reject(AppError.of('AI/BUSY', 'errors.AI_BUSY'));
    await expect(collected).rejects.toMatchObject({ code: 'AI/BUSY' });

    // cancel() порта обязан достать ВСЁ ЕЩЁ СТРИМЯЩУЮ №1 — раньше activeRequestId
    // был затёрт запуском №2 и очищен её отказом: cancel становился no-op, и
    // CancelGeneration use case'а (087) не могла остановить генерацию.
    engine.cancel();
    expect(client.cancels).toEqual([client.generations[0]!.requestId]);

    // Воркер закрывает №1 done(cancelled) — потребитель получает финал отмены.
    client.generations[0]!.resolve('cancelled');
    const rest = await finish(first.first, first.iterator);
    expect(rest.at(-1)).toEqual({ done: 'cancelled' });

    // Реестр in-flight пуст — cancel снова no-op.
    engine.cancel();
    expect(client.cancels).toHaveLength(1);
  });

  it('параллельные отмены не дублируются: BUSY-отказ №2 не оставляет лишний id в cancel() (ревью TASK-078)', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });

    const first = await startStream(engine.complete(request()));
    const collected = collect(engine.complete(request()));
    client.generations[1]!.reject(AppError.of('AI/BUSY', 'errors.AI_BUSY'));
    await expect(collected).rejects.toMatchObject({ code: 'AI/BUSY' });

    // Единственная адресат cancel() — стримящая №1; отклонённая №2 не отменяется.
    engine.cancel();
    expect(client.cancels).toEqual([client.generations[0]!.requestId]);

    client.generations[0]!.resolve('stop');
    await finish(first.first, first.iterator);
  });

  it('status: busy по состоянию клиента, modelId — из ensureModel', async () => {
    const client = new FakeProcessClient();
    const engine = new ProcessLlmEngine({ client });
    expect(engine.status()).toEqual({ loaded: false, busy: false });

    await engine.ensureModel('C:/models/gemma.gguf');
    expect(engine.status()).toEqual({
      loaded: true,
      modelId: 'C:/models/gemma.gguf',
      busy: false,
    });

    const started = await startStream(engine.complete(request()));
    client.state = 'busy';
    expect(engine.status()).toMatchObject({ busy: true });

    client.generations[0]!.resolve('stop');
    await finish(started.first, started.iterator);
    client.state = 'ready';
    expect(engine.status().busy).toBe(false);
  });
});
