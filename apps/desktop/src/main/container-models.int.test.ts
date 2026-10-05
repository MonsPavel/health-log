/**
 * TASK-081 §5/§9/§19/§20: проводка контейнера — ModelStore (080) как singleton
 * графа, AiModelsQueries и хендлеры ai/models/* в реестре каналов:
 *  - dispatch 'ai/models/list' через контейнер → витрина по БОЕВОМУ ресурсу
 *    манифеста (dev-placeholder-ru) + ramTotalGb (os.totalmem main) + uiLanguage 'ru';
 *  - dispatch 'ai/models/select' → prefs/get отражает aiSettings.modelId;
 *    чужой id → ApiFailure AI/MODEL_NOT_FOUND (§13);
 *  - TEST-INSTALL (§22, deps.testModelFilePath): dispatch 'ai/models/download' →
 *    файл скопирован в <userData>/models/<file> мимо сети, list показывает
 *    installed (e2e §20-6: скачать dev-модель → installed → select);
 *  - гард testModelFileEnabled (§14, паттерн fakeLlmEnabled): env только в
 *    не-packaged запуске.
 *
 * Сборка — в node-окружении vitest (прецедент container-llm-engine.int.test.ts);
 * vault — мок без safeStorage; сети нет: test-install мимо EgressGateway.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Clock, type Result, ok } from '@hl/kernel';

import { buildContainer, testModelFileEnabled, HL_TEST_MODEL_FILE_ENV } from './container.js';
import { AiModelsQueries } from './modules/ai-insight/application/models-queries.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ (§19) — 32 байта. */
const KEY_HEX = 'ab'.repeat(32);

/** Свежие tmp-userData; удаление в afterAll (§14). */
const baseDir = mkdtempSync(join(tmpdir(), 'hl-container-models-base-'));
const testInstallDir = mkdtempSync(join(tmpdir(), 'hl-container-models-testinstall-'));

/** Мок-vault без safeStorage (§19, прецедент container-llm-engine.int.test.ts). */
class MockVault implements KeyVault {
  /** TASK-121 §3: импорт ключа из копии — мок-заглушка (сценарий восстановление не зовёт). */
  importKey(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({ ok: true, value: { keyHex: KEY_HEX, created: true } });
  }

  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return Promise.resolve({
      ok: false,
      error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY),
    });
  }

  // TASK-093 §5/§7: парольные режимы в этом сценарии не используются — нейтральные
  // заглушки контракта (сессия всегда разблокирована, mode='none').
  setPassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  changePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  removePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  unlock(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  // TASK-094 §5: сброс сессии в mode=none — no-op (мок; см. порт key-vault).
  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

function testClock(): Clock {
  return new FixedClock(1_758_816_000_000, 180);
}

let baseContainer: Awaited<ReturnType<typeof buildContainer>> | undefined;
let testInstallContainer: Awaited<ReturnType<typeof buildContainer>> | undefined;

/** Dispatch-хелпер: развёрнутый конверт канала (§11). */
async function call<T>(
  container: NonNullable<typeof baseContainer>,
  channel: string,
  payload: unknown,
): Promise<{ ok: boolean; data?: T; error?: { code: string; messageKey: string } }> {
  const envelope = (await container.channels.dispatch({ channel, payload })) as {
    ok: boolean;
    data?: T;
    error?: { code: string; messageKey: string };
  };
  return envelope;
}

/** Файл «модели» для test-install (содержимое произвольно — верификации нет, §22). */
const FAKE_MODEL_PATH = join(testInstallDir, 'fake-model.gguf');

afterAll(() => {
  for (const [container, dir] of [
    [baseContainer, baseDir],
    [testInstallContainer, testInstallDir],
  ] as const) {
    try {
      container?.close();
    } catch {
      // закрыт сценарием — не важно для очистки
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('testModelFileEnabled — гард env-флага HL_TEST_MODEL_FILE (§22, паттерн §14)', () => {
  it('env с путём в не-packaged запуске — включён; пустая строка — нет', () => {
    expect(testModelFileEnabled({ [HL_TEST_MODEL_FILE_ENV]: 'C:\\m\\dev.gguf' }, false)).toBe(true);
    expect(testModelFileEnabled({ [HL_TEST_MODEL_FILE_ENV]: '' }, false)).toBe(false);
  });

  it('packaged игнорирует флаг (test-hook не попадает в продакшн); без env — нет', () => {
    expect(testModelFileEnabled({ [HL_TEST_MODEL_FILE_ENV]: 'C:\\m\\dev.gguf' }, true)).toBe(false);
    expect(testModelFileEnabled({}, false)).toBe(false);
  });
});

describe('buildContainer — витрина моделей в реестре каналов (TASK-081 §5/§9)', () => {
  it('aiModels — AiModelsQueries в графе; list через dispatch: боевой манифест + totalmem + ru', async () => {
    baseContainer = await buildContainer({
      userDataPath: baseDir,
      clock: testClock(),
      vault: () => new MockVault(),
    });

    expect(baseContainer.aiModels).toBeInstanceOf(AiModelsQueries);

    const envelope = await call<{
      models: { descriptor: { id: string }; state: string }[];
      ramTotalGb: number;
      uiLanguage: string;
    }>(baseContainer, 'ai/models/list', {});
    expect(envelope.ok).toBe(true);
    const data = envelope.data as NonNullable<typeof envelope.data>;
    expect(data.models.map((model) => model.descriptor.id)).toContain('dev-placeholder-ru');
    expect(data.models.every((model) => model.state === 'not_installed')).toBe(true);
    // ОЗУ машины — os.totalmem main (§5): положительное число ГБ; язык UI — 'ru' (§17).
    expect(data.ramTotalGb).toBeGreaterThan(0);
    expect(data.uiLanguage).toBe('ru');
  });

  it('select через dispatch → prefs/get отражает aiSettings.modelId (§5/§9)', async () => {
    baseContainer =
      baseContainer ??
      (await buildContainer({
        userDataPath: baseDir,
        clock: testClock(),
        vault: () => new MockVault(),
      }));

    const selected = await call<{ modelId: string }>(baseContainer, 'ai/models/select', {
      modelId: 'dev-placeholder-ru',
    });
    expect(selected.ok).toBe(true);
    expect(selected.data?.modelId).toBe('dev-placeholder-ru');

    const prefsEnvelope = await call<{ aiSettings: { modelId?: string; dismissed: boolean } }>(
      baseContainer,
      'prefs/get',
      {},
    );
    expect(prefsEnvelope.data?.aiSettings.modelId).toBe('dev-placeholder-ru');
  });

  it('select чужого id → ApiFailure AI/MODEL_NOT_FOUND (§13)', async () => {
    baseContainer =
      baseContainer ??
      (await buildContainer({
        userDataPath: baseDir,
        clock: testClock(),
        vault: () => new MockVault(),
      }));

    const envelope = await call(baseContainer, 'ai/models/select', { modelId: 'no-such' });
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('AI/MODEL_NOT_FOUND');
  });

  it('TEST-INSTALL (§22): download копирует локальный файл мимо сети → installed в list', async () => {
    writeFileSync(FAKE_MODEL_PATH, 'fake-gguf-bytes');
    testInstallContainer = await buildContainer({
      userDataPath: testInstallDir,
      clock: testClock(),
      vault: () => new MockVault(),
      testModelFilePath: FAKE_MODEL_PATH,
    });

    const envelope = await call<{ state: string }>(testInstallContainer, 'ai/models/download', {
      modelId: 'dev-placeholder-ru',
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.state).toBe('installed');

    // Файл на месте под именем дескриптора (§22: установка мимо сети)…
    expect(existsSync(join(testInstallDir, 'models', 'dev-placeholder.gguf'))).toBe(true);
    // …и list показывает installed (e2e §20-6: скачать → installed).
    const listEnvelope = await call<{
      models: { descriptor: { id: string }; state: string }[];
    }>(testInstallContainer, 'ai/models/list', {});
    const installed = listEnvelope.data?.models.find(
      (m) => m.descriptor.id === 'dev-placeholder-ru',
    );
    expect(installed?.state).toBe('installed');
  });
});
