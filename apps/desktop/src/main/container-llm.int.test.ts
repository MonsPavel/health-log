/**
 * TASK-076 §5/§9: проводка контейнера — клиент llm-worker (LlmProcessClient) —
 * СИНГЛТОН графа (§9), события ai:status/ai:token идут в боевой мост
 * broadcastToWindows (§11; как net:activity у 075). Сборка — в node-окружении
 * vitest (прецедент container.int.test.ts, §20 п. 4): spawn не выполняется
 * (ленивый, §5), close() контейнера останавливает клиента (dispose — §9), и
 * dispose идемпотентен.
 *
 * Синглтонность проверяется по факту графа: поле Container одно, фабрики нет —
 * повторного построения быть не может (тест фиксирует тип и идемпотентность).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Clock, type Result, ok } from '@hl/kernel';

import { buildContainer } from './container.js';
import { LlmProcessClient } from './modules/ai-insight/adapters/llm-process-client.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ (§19) — 32 байта. */
const KEY_HEX = 'cd'.repeat(32);

/** Свежий tmp-userData; удаление в afterAll (§14). */
const dir = mkdtempSync(join(tmpdir(), 'hl-container-llm-int-'));

/** Мок-vault без safeStorage (§19, прецедент container.int.test.ts). */
class MockVault implements KeyVault {
  constructor(private readonly keyHex: string) {}

  /** TASK-121 §3: импорт ключа из копии — мок-заглушка (сценарий восстановление не зовёт). */
  importKey(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({ ok: true, value: { keyHex: this.keyHex, created: true } });
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

let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

afterAll(() => {
  try {
    container?.close();
  } catch {
    // закрыт сценарием — не важно для очистки
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('buildContainer — llm-worker клиент (TASK-076 §9)', () => {
  it('llm — синглтон графа; close() останавливает его; повторный dispose — no-op', async () => {
    const clock: Clock = new FixedClock(1_758_816_000_000, 180);
    container = await buildContainer({
      userDataPath: dir,
      clock,
      vault: () => new MockVault(KEY_HEX),
    });

    // Синглтон в графе (§9): поле контейнера, не фабрика.
    expect(container.llm).toBeInstanceOf(LlmProcessClient);
    expect(container.llm.state).toBe('starting'); // ленивый spawn: воркер ещё не нужен

    // Graceful shutdown (§9): close() контейнера disposing клиента без ошибок.
    expect(() => container?.close()).not.toThrow();
    expect(() => container?.llm.dispose()).not.toThrow(); // идемпотентность dispose
    // Повторный close — no-op (§8, прецедент container.int.test.ts).
    expect(() => container?.close()).not.toThrow();
  });
});
