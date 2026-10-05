// TASK-087 §5/§11/§12: проводка контейнера — хранилище резюме (v6), use case
// GenerateSummary и каналы ai/summary/generate|latest + ai/cancel. Сборка — в
// node-окружении vitest (прецедент container-llm.int.test.ts, §20 п. 4): движок —
// боевой ProcessLlmEngine, но spawn ленив (генерация не запускается: модель не
// выбрана в prefs по умолчанию — путь MODEL_NOT_CONFIGURED, §8 арх. 07).
//
// Матрица:
//  1. insightRepo/generateSummary — синглтоны графа нужных классов;
//  2. ai/summary/latest на пустой БД → ok с data undefined (валидный ответ §12);
//  3. битый payload generate (лишнее поле, strict §14) → VALIDATION/FAILED, use case
//     не вызван (записей нет);
//  4. ai/summary/generate с валидным payload → {requestId} (фон: модель не выбрана —
//     фоновый отказ честно погашен логом; записей нет); ai/cancel по этому id →
//     {cancelled: true} (реестр общий с generate).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Clock, type Result, ok } from '@hl/kernel';

import { buildContainer } from './container.js';
import { GenerateSummary } from './modules/ai-insight/application/generate-summary.js';
import { SqliteInsightRepository } from './modules/ai-insight/adapters/sqlite-insight-repository.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ (§19) — 32 байта. */
const KEY_HEX = 'cd'.repeat(32);

/** Свежий tmp-userData; удаление в afterAll (§14). */
const dir = mkdtempSync(join(tmpdir(), 'hl-container-summary-int-'));

/** Мок-vault без safeStorage (§19, прецедент container-llm.int.test.ts). */
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

const clock: Clock = new FixedClock(1_758_816_000_000, 180);

let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

afterAll(() => {
  try {
    container?.close();
  } catch {
    // закрыт сценарием — не важно для очистки
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('buildContainer — резюме периода (TASK-087 §11)', () => {
  it('(1) insightRepo/generateSummary — синглтоны графа нужных классов', async () => {
    container = await buildContainer({
      userDataPath: dir,
      clock,
      vault: () => new MockVault(),
    });
    expect(container.insightRepo).toBeInstanceOf(SqliteInsightRepository);
    expect(container.generateSummary).toBeInstanceOf(GenerateSummary);
  });

  it('(2) ai/summary/latest на пустой БД → ok, data undefined (валидный ответ §12)', async () => {
    const response = await container!.channels.dispatch({
      channel: 'ai/summary/latest',
      payload: { profileId: 'seed-profile-0001', period: '7d' },
    });
    expect(response).toMatchObject({ ok: true, data: undefined });
  });

  it('(3) битый payload generate (strict §14) → VALIDATION/FAILED, use case не вызван', async () => {
    const response = await container!.channels.dispatch({
      channel: 'ai/summary/generate',
      payload: { profileId: 'seed-profile-0001', period: '7d', includeNotes: false, extra: 1 },
    });
    expect(response.ok).toBe(false);
    expect(response).toMatchObject({ error: { code: 'VALIDATION/FAILED' } });
    const latest = await container!.channels.dispatch({
      channel: 'ai/summary/latest',
      payload: { profileId: 'seed-profile-0001', period: '7d' },
    });
    expect(latest).toMatchObject({ ok: true, data: undefined });
  });

  it('(4) generate → {requestId}; ai/cancel по нему → {cancelled: true} (реестр общий)', async () => {
    const generate = await container!.channels.dispatch({
      channel: 'ai/summary/generate',
      payload: { profileId: 'seed-profile-0001', period: '30d', includeNotes: false },
    });
    expect(generate.ok).toBe(true);
    if (!generate.ok) {
      return; // сужение union для type-безопасного .data (прецедент trends.int.test.ts)
    }
    const requestId = (generate.data as { requestId: string }).requestId;
    expect(requestId.length).toBeGreaterThan(0);

    const cancel = await container!.channels.dispatch({
      channel: 'ai/cancel',
      payload: { requestId },
    });
    expect(cancel).toMatchObject({ ok: true, data: { cancelled: true } });

    // Фон: модель не выбрана — use case погасил AI/ENGINE_NOT_CONFIGURED, записей нет.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const latest = await container!.channels.dispatch({
      channel: 'ai/summary/latest',
      payload: { profileId: 'seed-profile-0001', period: '30d' },
    });
    expect(latest).toMatchObject({ ok: true, data: undefined });
  });
});
