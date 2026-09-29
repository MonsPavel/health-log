/**
 * TASK-078 §19/§20: порт-тесты LlmEngine на FakeLlmEngine — поведение как у
 * реального движка (стрим, отмена, BUSY), поэтому тесты проверяют ЦЕННОСТЬ, не
 * имплементацию (§4):
 *  - стрим-последовательность детерминирована: два прогона с одинаковым запросом —
 *    идентичные последовательности чанков; дельты восстанавливают текст ответа;
 *  - §16–17/§22: префикс [FAKE] обязателен в начале КАЖДОГО ответа (защита от
 *    спутывания с реальным ИИ на скриншотах);
 *  - §5: сценарная таблица — «средн*» → текст-резюме из констант, иначе —
 *    безопасный нейтральный текст;
 *  - §13: abort посреди стрима → done(cancelled), слот освобождён; abort ДО
 *    старта → немедленный done(cancelled) без занятия слота;
 *  - §13: вторая генерация до завершения первой → AI/BUSY; после завершения —
 *    генерация возможна (тесты оркестрации честны);
 *  - §19: ensureModel идемпотентен (статус loaded/modelId);
 *  - §13: cancel() — кооперативная отмена активной генерации → done(cancelled);
 *  - §15: 1000 токенов при задержке 0 — быстрее 50 мс (стрим без таймеров);
 *  - §5: микро-задержка configurable: слова приходят не мгновенно при delayMs > 0.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '@hl/kernel';

import {
  FAKE_LLM_PREFIX,
  FAKE_AVERAGE_SUMMARY_RESPONSE,
  FAKE_NEUTRAL_RESPONSE,
  FakeLlmEngine,
  type FakeLlmScenario,
} from './fake-llm-engine.js';
import type { LlmEngineChunk, LlmEngineRequest } from '../application/ports/llm-engine.js';

/** Собирает поток в массив чанков (ошибка генератора — reject промиса-обёртки). */
async function collect(stream: AsyncIterable<LlmEngineChunk>): Promise<LlmEngineChunk[]> {
  const chunks: LlmEngineChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Открывает поток и берёт ПЕРВЫЙ чанк вручную — итератор остаётся открытым
 * (слот генерации занят; for-await c break закрыл бы генератор return-ом и
 * освободил бы слот — семантика AsyncGenerator, а не движка).
 */
async function openStream(stream: AsyncIterable<LlmEngineChunk>): Promise<{
  iterator: AsyncIterator<LlmEngineChunk>;
  first: IteratorResult<LlmEngineChunk>;
}> {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  return { iterator, first };
}

/** Дочитывает открытый итератор до конца, собирая оставшиеся чанки. */
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

/** Соединяет дельты стрима в полный текст ответа. */
function deltasText(chunks: readonly LlmEngineChunk[]): string {
  return chunks.map((chunk) => ('delta' in chunk ? chunk.delta : '')).join('');
}

/** Запрос по умолчанию (форма §7: стандартный LLM-формат chat-сообщений). */
function request(
  content: string,
  signal: AbortSignal = new AbortController().signal,
): LlmEngineRequest {
  return { messages: [{ role: 'user', content }], signal };
}

/** Контроллер с сигналом — удобство для тестов отмены. */
function abortable(): { controller: AbortController; signal: AbortSignal } {
  const controller = new AbortController();
  return { controller, signal: controller.signal };
}

describe('FakeLlmEngine — детерминированный стрим (TASK-078 §5)', () => {
  it('стрим детерминирован: два прогона — идентичные последовательности чанков', async () => {
    const engine = new FakeLlmEngine();
    const first = await collect(engine.complete(request('Расскажи о давлении')));
    const second = await collect(engine.complete(request('Расскажи о давлении')));

    expect(first).toEqual(second);
    // Финал потока — done(stop) последним чанком (§5).
    expect(first.at(-1)).toEqual({ done: 'stop' });
  });

  it('каждый ответ начинается с обязательного префикса [FAKE] (§16–17/§22)', async () => {
    const engine = new FakeLlmEngine();
    const neutral = await collect(engine.complete(request('привет')));
    const summary = await collect(engine.complete(request('Составь резюме по средним значениям')));

    expect(deltasText(neutral).startsWith(`${FAKE_LLM_PREFIX} `)).toBe(true);
    expect(deltasText(summary).startsWith(`${FAKE_LLM_PREFIX} `)).toBe(true);
    // Первый чанк — само слово-префикс (пометка видна с первого токена).
    expect(neutral[0]).toEqual({ delta: `${FAKE_LLM_PREFIX} ` });
  });

  it('сценарная таблица: запрос про «средние» — текст-резюме, прочий запрос — нейтральный текст (§5)', async () => {
    const engine = new FakeLlmEngine();

    const summary = deltasText(
      await collect(engine.complete(request('Сделай резюме по среднему АД'))),
    );
    expect(summary).toBe(`${FAKE_LLM_PREFIX} ${FAKE_AVERAGE_SUMMARY_RESPONSE}`);

    const neutral = deltasText(await collect(engine.complete(request('Что такое пульс?'))));
    expect(neutral).toBe(`${FAKE_LLM_PREFIX} ${FAKE_NEUTRAL_RESPONSE}`);
  });

  it('стрим идёт по словам: дельты не пусты и их больше одной (§5 «стрим по словам»)', async () => {
    const engine = new FakeLlmEngine();
    const chunks = await collect(engine.complete(request('любой запрос')));

    const deltas = chunks.filter((chunk): chunk is { delta: string } => 'delta' in chunk);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((chunk) => chunk.delta.length > 0)).toBe(true);
  });
});

describe('FakeLlmEngine — BUSY и слот генерации (TASK-078 §13)', () => {
  it('вторая генерация до завершения первой — AI/BUSY при первом шаге итерации', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });
    const first = engine.complete(request('первый'));
    // Поток ОТКРЫТ (итератор приостановлен вне for-await) — слот занят.
    const opened = await openStream(first);
    expect(opened.first.done ?? false).toBe(false);

    const second = engine.complete(request('второй'));
    await expect(collect(second)).rejects.toMatchObject({ code: 'AI/BUSY' });
    // Наружу — AppError контракта ошибок (TASK-006), не Error.
    await expect(collect(engine.complete(request('третий')))).rejects.toBeInstanceOf(AppError);

    // Первая генерация дочитана — слот освободился.
    await drain(opened.iterator);
    const resumed = await collect(engine.complete(request('четвёртый')));
    expect(resumed.length).toBeGreaterThan(0);
  });

  it('после завершения генерации статус busy сброшен (§7 EngineStatus)', async () => {
    const engine = new FakeLlmEngine();
    expect(engine.status().busy).toBe(false);
    await collect(engine.complete(request('запрос')));
    expect(engine.status().busy).toBe(false);
  });

  it('BUSY-отказ второй параллельной не затрагивает слот №1: cancel() достаёт стримящую (ревью TASK-078 — зеркально process-адаптеру, §4)', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });
    const first = engine.complete(request('первый'));
    const opened = await openStream(first);

    // Вторая генерация отклонена BUSY (до занятия слота — активной остаётся №1).
    await expect(collect(engine.complete(request('второй')))).rejects.toMatchObject({
      code: 'AI/BUSY',
    });

    // cancel() порта отменяет именно стримящую №1.
    engine.cancel();
    const rest = await drain(opened.iterator);
    expect(rest.at(-1)).toEqual({ done: 'cancelled' });
    expect(engine.status().busy).toBe(false);
  });
});

describe('FakeLlmEngine — отмена (TASK-078 §13)', () => {
  it('abort посреди стрима → done(cancelled), слот освобождён', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });
    const { controller, signal } = abortable();
    const stream = engine.complete(request('запрос', signal));

    const opened = await openStream(stream);
    expect(opened.first.done ?? false).toBe(false);

    controller.abort();
    const rest = await drain(opened.iterator);
    expect(rest.at(-1)).toEqual({ done: 'cancelled' });
    expect(engine.status().busy).toBe(false);

    // Освобождённый слот принимает новую генерацию.
    const resumed = await collect(engine.complete(request('снова')));
    expect(resumed.length).toBeGreaterThan(0);
  });

  it('abort ДО старта → немедленный done(cancelled), слот не занимался', async () => {
    const engine = new FakeLlmEngine();
    const { controller, signal } = abortable();
    controller.abort();

    const chunks = await collect(engine.complete(request('запрос', signal)));
    expect(chunks).toEqual([{ done: 'cancelled' }]);
    expect(engine.status().busy).toBe(false);
  });

  it('cancel() без сигнала — кооперативная отмена активной генерации → done(cancelled)', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });
    const stream = engine.complete(request('запрос'));
    const opened = await openStream(stream);

    engine.cancel();
    const rest = await drain(opened.iterator);
    expect(rest.at(-1)).toEqual({ done: 'cancelled' });

    // Идемпотентность: cancel без активной генерации — no-op (не бросает).
    expect(() => engine.cancel()).not.toThrow();
  });

  it('незавершённый потребителем поток (разрыв итерации) освобождает слот', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });
    const stream = engine.complete(request('запрос'));
    const opened = await openStream(stream);
    // Разрыв for-await (return() генератора) — слот должен освободиться.
    await opened.iterator.return?.();

    expect(engine.status().busy).toBe(false);
  });
});

describe('FakeLlmEngine — ensureModel и статус (TASK-078 §19/§7)', () => {
  it('ensureModel идемпотентен; статус отражает loaded/modelId/busy', async () => {
    const engine = new FakeLlmEngine();
    expect(engine.status()).toEqual({ loaded: false, busy: false });

    await engine.ensureModel('model-a');
    expect(engine.status()).toEqual({ loaded: true, modelId: 'model-a', busy: false });

    // Повторный вызов с тем же id — no-op (идемпотентность §19).
    await engine.ensureModel('model-a');
    expect(engine.status()).toEqual({ loaded: true, modelId: 'model-a', busy: false });

    // Переключение модели — новый id.
    await engine.ensureModel('model-b');
    expect(engine.status()).toEqual({ loaded: true, modelId: 'model-b', busy: false });
  });

  it('во время генерации статус busy=true с modelId', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });
    await engine.ensureModel('model-a');
    const opened = await openStream(engine.complete(request('запрос')));

    expect(engine.status()).toEqual({ loaded: true, modelId: 'model-a', busy: true });
    await drain(opened.iterator);
    expect(engine.status().busy).toBe(false);
  });
});

describe('FakeLlmEngine — производительность и задержка (TASK-078 §15/§5)', () => {
  it('1000 токенов при задержке 0 — быстрее 50 мс (§15)', async () => {
    // Таблица с длинным ответом (1000 слов) — «токены» fake = слова.
    const words = Array.from({ length: 1000 }, (_, i) => `слово${i}`).join(' ');
    const scenarios: readonly FakeLlmScenario[] = [{ keywords: ['длинный'], response: words }];
    const engine = new FakeLlmEngine({ scenarios });

    const startedAt = performance.now();
    const chunks = await collect(engine.complete(request('длинный ответ')));
    const elapsedMs = performance.now() - startedAt;

    // 1000 слов сценария + слово-префикс [FAKE] + финальный done.
    expect(chunks).toHaveLength(1002);
    expect(elapsedMs).toBeLessThan(50);
  });

  it('delayMs > 0 — слова приходят с микро-задержкой, не мгновенно (§5)', async () => {
    const engine = new FakeLlmEngine({ delayMs: 5 });

    const startedAt = performance.now();
    await collect(engine.complete(request('один два три четыре пять')));
    const elapsedMs = performance.now() - startedAt;

    // Нижняя граница безопасна от дрожи таймеров: ≥ ~4 задержек на 5 слов.
    expect(elapsedMs).toBeGreaterThanOrEqual(4 * 5);
  });
});
