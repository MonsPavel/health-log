/**
 * TASK-078 §5/§19/§20: проводка контейнера — выбор движка LLM за портом
 * LlmEngine (llmEngine — синглтон графа):
 *  - гард fakeLlmEnabled(env, isPackaged) — env HL_FAKE_LLM=1 ТОЛЬКО в
 *    не-packaged запуске (§14 — паттерн benchChannelsEnabled TASK-062; тест
 *    эмуляции packaged, AC4);
 *  - параметр useFakeLlm переключает движок без process.env-мутаций (§19):
 *    true → FakeLlmEngine, false/по умолчанию → ProcessLlmEngine над клиентом
 *    076 (тест обеих веток с моком процесса — клиент ленивый, spawn нет, AC2);
 *  - интеграционная мини (AC3): генерация через container.llmEngine при fake —
 *    [FAKE]-префикс и финал done(stop) без процессов;
 *  - close() контейнера останавливает боевой клиент в реальной ветке.
 *
 * Сборка — в node-окружении vitest (прецедент container-llm.int.test.ts 076,
 * §20 п. 4); vault — мок без safeStorage.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Clock, type Result } from '@hl/kernel';

import {
  buildContainer,
  fakeLlmDelayMs,
  fakeLlmEnabled,
  HL_FAKE_LLM_DELAY_MS_ENV,
  HL_FAKE_LLM_ENV,
} from './container.js';
import { LlmProcessClient } from './modules/ai-insight/adapters/llm-process-client.js';
import { FakeLlmEngine, FAKE_LLM_PREFIX } from './modules/ai-insight/adapters/fake-llm-engine.js';
import { ProcessLlmEngine } from './modules/ai-insight/adapters/process-llm-engine.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ (§19) — 32 байта. */
const KEY_HEX = 'cd'.repeat(32);

/** Свежие tmp-userData по веткам; удаление в afterAll (§14). */
const fakeDir = mkdtempSync(join(tmpdir(), 'hl-container-llm-fake-'));
const realDir = mkdtempSync(join(tmpdir(), 'hl-container-llm-real-'));

/** Мок-vault без safeStorage (§19, прецедент container-llm.int.test.ts). */
class MockVault implements KeyVault {
  constructor(private readonly keyHex: string) {}

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({ ok: true, value: { keyHex: this.keyHex, created: true } });
  }

  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return Promise.resolve({
      ok: false,
      error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY),
    });
  }
}

/** Фиксированное время тестов. */
function testClock(): Clock {
  return new FixedClock(1_758_816_000_000, 180);
}

let fakeContainer: Awaited<ReturnType<typeof buildContainer>> | undefined;
let realContainer: Awaited<ReturnType<typeof buildContainer>> | undefined;

afterAll(() => {
  for (const [container, dir] of [
    [fakeContainer, fakeDir],
    [realContainer, realDir],
  ] as const) {
    try {
      container?.close();
    } catch {
      // закрыт сценарием — не важно для очистки
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('fakeLlmEnabled — гард env-флага (TASK-078 §14, AC4)', () => {
  it('HL_FAKE_LLM=1 в не-packaged запуске — включён', () => {
    expect(fakeLlmEnabled({ [HL_FAKE_LLM_ENV]: '1' }, false)).toBe(true);
  });

  it('packaged игнорирует флаг (§14 — паттерн HL_BENCH)', () => {
    expect(fakeLlmEnabled({ [HL_FAKE_LLM_ENV]: '1' }, true)).toBe(false);
  });

  it('без флага и с прочими значениями — выключен', () => {
    expect(fakeLlmEnabled({}, false)).toBe(false);
    expect(fakeLlmEnabled({ [HL_FAKE_LLM_ENV]: '0' }, false)).toBe(false);
    expect(fakeLlmEnabled({ [HL_FAKE_LLM_ENV]: 'true' }, false)).toBe(false);
  });
});

describe('fakeLlmDelayMs — гард задержки fake-движка (TASK-090 §19/§20)', () => {
  it('валидное целое > 0 с HL_FAKE_LLM=1 в не-packaged запуске — задержка', () => {
    expect(fakeLlmDelayMs({ [HL_FAKE_LLM_ENV]: '1', [HL_FAKE_LLM_DELAY_MS_ENV]: '30' }, false)).toBe(30);
  });

  it('без HL_FAKE_LLM=1 или в packaged — undefined (§14: только dev/e2e)', () => {
    expect(fakeLlmDelayMs({ [HL_FAKE_LLM_DELAY_MS_ENV]: '30' }, false)).toBeUndefined();
    expect(
      fakeLlmDelayMs({ [HL_FAKE_LLM_ENV]: '1', [HL_FAKE_LLM_DELAY_MS_ENV]: '30' }, true),
    ).toBeUndefined();
  });

  it('мусор, 0 и отрицательное — undefined (дефолт движка 0)', () => {
    const env = { [HL_FAKE_LLM_ENV]: '1' };
    expect(fakeLlmDelayMs(env, false)).toBeUndefined();
    expect(fakeLlmDelayMs({ ...env, [HL_FAKE_LLM_DELAY_MS_ENV]: 'abc' }, false)).toBeUndefined();
    expect(fakeLlmDelayMs({ ...env, [HL_FAKE_LLM_DELAY_MS_ENV]: '0' }, false)).toBeUndefined();
    expect(fakeLlmDelayMs({ ...env, [HL_FAKE_LLM_DELAY_MS_ENV]: '-5' }, false)).toBeUndefined();
  });
});

describe('buildContainer — выбор движка LlmEngine (TASK-078 §5/§19, AC2)', () => {
  it('useFakeLlm: true → FakeLlmEngine; генерация через порт — [FAKE] и done(stop) (интеграционная мини, AC3)', async () => {
    fakeContainer = await buildContainer({
      userDataPath: fakeDir,
      clock: testClock(),
      vault: () => new MockVault(KEY_HEX),
      useFakeLlm: true,
    });

    expect(fakeContainer.llmEngine).toBeInstanceOf(FakeLlmEngine);

    // Интеграционная мини: e2e-режим без модели — ответ с обязательным префиксом.
    const deltas: string[] = [];
    let finish: string | undefined;
    for await (const chunk of fakeContainer.llmEngine.complete({
      messages: [{ role: 'user', content: 'Составь резюме' }],
      signal: new AbortController().signal,
    })) {
      if ('delta' in chunk) {
        deltas.push(chunk.delta);
      } else {
        finish = chunk.done;
      }
    }
    expect(deltas.join('').startsWith(`${FAKE_LLM_PREFIX} `)).toBe(true);
    expect(finish).toBe('stop');
    // Сборка контейнера не спавнит и в fake-режиме: боевой клиент не нужен.
    expect(fakeContainer.llm.state).toBe('starting');
  });

  it('useFakeLlm: false (по умолчанию) → ProcessLlmEngine над боевым клиентом 076 (spawn ленивый)', async () => {
    realContainer = await buildContainer({
      userDataPath: realDir,
      clock: testClock(),
      vault: () => new MockVault(KEY_HEX),
      useFakeLlm: false,
    });

    expect(realContainer.llmEngine).toBeInstanceOf(ProcessLlmEngine);
    // Обёртка над ТЕМ ЖЕ синглтоном клиента графа (не копия).
    expect(realContainer.llmEngine.client).toBe(realContainer.llm);
    // Моком процесса служит ленивость клиента: сборка контейнера не спавнит (§19).
    expect(realContainer.llm.state).toBe('starting');
    expect(realContainer.llm).toBeInstanceOf(LlmProcessClient);

    // Graceful shutdown (§9 076): close() контейнера останавливает боевой клиент.
    expect(() => realContainer?.close()).not.toThrow();
  });
});
