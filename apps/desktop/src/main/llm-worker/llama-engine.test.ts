/**
 * TASK-077 §5/§19/§24: адаптер node-llama-cpp.
 *
 * БЕЗ модели (CI): чистые узлы — расчёт потоков (физические ядра−1, §4),
 * env-дефолт окна idle-unload (§20), контракт createDefaultLlmEngine БЕЗ
 * касания натива (валидация пути раньше бэкенда — AI/MODEL_FILE_MISSING,
 * генерация без модели — AI/NO_MODEL).
 *
 * [model]-тесты (ручной запуск, §24): требуют dev-GGUF (1B Q4, ~700 МБ, вне
 * репо) через env HL_TEST_MODEL — в CI модели нет, describe пропускается.
 * Запуск: HL_TEST_MODEL=<путь> pnpm exec vitest run llama-engine
 */
import { describe, expect, it, vi } from 'vitest';

import {
  LLM_ENGINE_ERROR,
  createManagedLlamaEngine,
  type LlmEngineLogCall,
  type LlmEngineLogger,
} from './engine.js';
import {
  createDefaultLlmEngine,
  createNodeLlamaBackend,
  resolveDefaultIdleUnloadMs,
  resolveThreads,
} from './llama-engine.js';
import { EngineError } from './protocol.js';

const MODEL_PATH = process.env['HL_TEST_MODEL'];
const hasModel = typeof MODEL_PATH === 'string' && MODEL_PATH.length > 0;

/** Логгер-шпион (§18: замеры генерации идут в лог — ассерт по структуре). */
function createLoggerSpy(): { logger: LlmEngineLogger; calls: LlmEngineLogCall[] } {
  const calls: LlmEngineLogCall[] = [];
  const push =
    (level: LlmEngineLogCall['level']) =>
    (message: string, meta = {}) => {
      calls.push({ level, message, meta });
    };
  return {
    calls,
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
  };
}

describe('llama-engine — узлы без модели (CI)', () => {
  it('resolveThreads — физические ядра−1 (§4): логические/2 округление вверх, минимум 1', () => {
    expect(resolveThreads(16)).toBe(7); // 8 физических − 1
    expect(resolveThreads(8)).toBe(3); // 4 физических − 1
    expect(resolveThreads(2)).toBe(1); // 1 физическое − 1 → минимум 1
    expect(resolveThreads(1)).toBe(1);
    expect(resolveThreads(0)).toBe(1); // защитный минимум
  });

  it('resolveDefaultIdleUnloadMs — env HL_LLM_IDLE_UNLOAD_MS, мусор → дефолт 5 мин (§20)', () => {
    expect(resolveDefaultIdleUnloadMs({})).toBe(5 * 60 * 1000);
    expect(resolveDefaultIdleUnloadMs({ HL_LLM_IDLE_UNLOAD_MS: '1000' })).toBe(1000);
    expect(resolveDefaultIdleUnloadMs({ HL_LLM_IDLE_UNLOAD_MS: 'abc' })).toBe(5 * 60 * 1000);
  });

  it('createDefaultLlmEngine — порт 076 целиком; ошибки валидации БЕЗ натива', async () => {
    const engine = createDefaultLlmEngine();
    expect(typeof engine.load).toBe('function');
    expect(typeof engine.unload).toBe('function');
    expect(typeof engine.complete).toBe('function');
    expect(typeof engine.cancel).toBe('function');

    // §13: несуществующий файл отсекается валидацией — нативный import не вызывается
    await expect(engine.load('Z:/точно-нет/model.gguf')).rejects.toMatchObject({
      workerErrorCode: LLM_ENGINE_ERROR.MODEL_FILE_MISSING,
    });
    // §13: генерация без модели — AI/NO_MODEL
    await expect(
      engine.complete(
        { requestId: 'g1', messages: [{ role: 'user', content: 'вопрос' }], maxTokens: 4 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(EngineError);
    expect(() => engine.cancel('g1')).not.toThrow();
    await expect(engine.unload()).resolves.toBeUndefined();
  });

  it('createNodeLlamaBackend — LlamaBackend-порт (loadModel + config contextSize)', () => {
    const backend = createNodeLlamaBackend();
    expect(typeof backend.loadModel).toBe('function');
  });
});

describe.skipIf(!hasModel)('llama-engine [model] — ручной прогон (§19/§24)', () => {
  const modelPath = MODEL_PATH as string;

  it(
    'load → generate → стрим → done(stop); замер §15 в логе (tokens/tps/firstTokenMs)',
    { timeout: 300_000 },
    async () => {
      const { logger, calls } = createLoggerSpy();
      const engine = createManagedLlamaEngine(createNodeLlamaBackend({ logger }), {
        logger,
        idleUnloadMs: 60 * 60 * 1000, // ручной прогон: без авто-выгрузки посреди теста
      });

      await engine.load(modelPath);

      const deltas: string[] = [];
      const finishReason = await engine.complete(
        {
          requestId: 'model-1',
          messages: [
            { role: 'system', content: 'Отвечай кратко по-русски.' },
            {
              role: 'user',
              content: 'Скажи одно короткое предложение о пользе измерений давления.',
            },
          ],
          maxTokens: 64,
        },
        (delta) => deltas.push(delta),
      );

      expect(finishReason).toBe('stop');
      expect(deltas.join('').length).toBeGreaterThan(0);

      const stats = calls.find((call) => 'tokens' in call.meta);
      expect(stats).toBeDefined();
      const meta = stats?.meta as { tokens: number; tps: number; firstTokenMs: number };
      expect(meta.tokens).toBeGreaterThan(0);
      expect(meta.firstTokenMs).toBeGreaterThanOrEqual(0);
      expect(meta.tps).toBeGreaterThan(0);
      // значения — перенести в таблицу docs/dev/local-llm.md (§15/§20)
      console.log(`[model] замер:`, JSON.stringify(meta));

      await engine.unload();
    },
  );

  it(
    'cancel останавливает генерацию: done(cancelled), после отмены токенов нет',
    { timeout: 300_000 },
    async () => {
      const { logger } = createLoggerSpy();
      const engine = createManagedLlamaEngine(createNodeLlamaBackend({ logger }), {
        logger,
        idleUnloadMs: 60 * 60 * 1000,
      });
      await engine.load(modelPath);

      const deltas: string[] = [];
      const done = engine.complete(
        {
          requestId: 'model-2',
          messages: [{ role: 'user', content: 'Расскажи длинную историю на тысячу слов.' }],
          maxTokens: 512,
        },
        (delta) => deltas.push(delta),
      );
      // ждём первый токен (модель может отдавать дельты пачками)
      for (let attempt = 0; attempt < 6000 && deltas.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      expect(deltas.length).toBeGreaterThan(0);

      const startedAt = Date.now();
      engine.cancel('model-2');
      await expect(done).resolves.toBe('cancelled');
      const cancelMs = Date.now() - startedAt;
      expect(cancelMs).toBeLessThan(1_000); // §20: cancel останавливает <1 с

      const lengthAtCancel = deltas.join('').length;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(deltas.join('').length).toBe(lengthAtCancel); // стрим остановлен

      await engine.unload();
    },
  );

  it(
    'idle-unload по сокращённому окну из env (§20 ручной сценарий)',
    { timeout: 300_000 },
    async () => {
      vi.stubEnv('HL_LLM_IDLE_UNLOAD_MS', '1500');
      const { logger, calls } = createLoggerSpy();
      const engine = createDefaultLlmEngine({ logger });

      await engine.load(modelPath);
      await new Promise<void>((resolve) => setTimeout(resolve, 2_500));

      // после idle-unload генерация честно отвечает NO_MODEL (состояние no-model, §12)
      await expect(
        engine.complete(
          { requestId: 'model-3', messages: [{ role: 'user', content: 'вопрос' }], maxTokens: 4 },
          () => undefined,
        ),
      ).rejects.toMatchObject({ workerErrorCode: LLM_ENGINE_ERROR.NO_MODEL });
      expect(calls.some((call) => (call.meta as { reason?: string }).reason === 'idle')).toBe(true);
      vi.unstubAllEnvs();
    },
  );
});
