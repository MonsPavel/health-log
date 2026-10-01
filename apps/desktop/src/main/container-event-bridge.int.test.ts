// TASK-088 §12: мост доменных событий Measurement шина→окна. События
// measurement:changed / data:versionBumped публикуются use case'ами журнала в
// EventBus (029/032/037), но БЕЗ моста до окон не доходят — рендерер обязан
// перечитывать данные после правок (стейлс-бейдж резюме §12, превью AC-5.5,
// прецеденты подписок ['trend']/['stats'] 057/059). Форвардинг — ТОЛЬКО для этих
// двух имён: стрим/статусы ИИ (076), прогресс моделей (080), net:activity (075) и
// финал 'ai/summary/result' (087) публикуются своими источниками НАПРЯМУЮ через
// broadcastToWindows — общий форвардер задваивал бы доставку (FIFO внутри имени
// нарушился бы дублем).
//
// Тест: vi.mock модуля broadcast (боевой синглтон тянет electron webContents —
// в node-витест его вызовы подменяются spy), buildContainer, dispatch
// measurements/add → ровно по одному событию каждого имени.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { broadcastToWindows } from './events/broadcast.js';
import { AppError, FixedClock, type Clock, type Result, ok } from '@hl/kernel';

import { buildContainer } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

vi.mock('./events/broadcast.js', () => ({
  broadcastToWindows: vi.fn(),
}));

/** Фиксированный тестовый ключ (§19, прецедент container-summary.int.test.ts). */
const KEY_HEX = 'ab'.repeat(32);

/** Мок-vault без safeStorage (§19). */
class MockVault implements KeyVault {
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

/** tmp-каталоги этой сессии — удаляются в afterAll (§14, прецедент full-cycle). */
const dirs: string[] = [];

beforeEach(() => {
  vi.mocked(broadcastToWindows).mockClear();
  dirs.push(mkdtempSync(join(tmpdir(), 'hl-event-bridge-int-')));
  dir = dirs[dirs.length - 1]!;
});

/** Свежий tmp-userData на каждый тест (данные изолированы, §14). */
let dir: string;

afterAll(() => {
  for (const path of dirs) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('мост EventBus → окна: доменные события Measurement (TASK-088 §12)', () => {
  it('measurements/add доставляет в окна measurement:changed и data:versionBumped', async () => {
    const container = await buildContainer({
      userDataPath: dir,
      clock,
      vault: () => new MockVault(),
    });
    try {
      const response = await container.channels.dispatch({
        channel: 'measurements/add',
        payload: {
          profileId: 'seed-profile-0001',
          sys: 120,
          dia: 80,
          pulse: 60,
          irregularPulse: false,
          arm: 'right',
          takenAt: { utcMs: 1_758_816_000_000 - 3_600_000, tzOffsetMin: 180 },
        },
      });
      expect(response.ok).toBe(true);

      const names = vi.mocked(broadcastToWindows).mock.calls.map((call) => call[0]);
      expect(names).toContain('measurement:changed');
      expect(names).toContain('data:versionBumped');
      expect(names.filter((name) => name === 'measurement:changed')).toHaveLength(1);
    } finally {
      container.close();
    }
  });

  it('стримовые события ИИ через шину НЕ дублируются (их публикуют напрямую, §12)', async () => {
    const container = await buildContainer({
      userDataPath: dir,
      clock,
      vault: () => new MockVault(),
    });
    try {
      await container.channels.dispatch({
        channel: 'measurements/add',
        payload: {
          profileId: 'seed-profile-0001',
          sys: 121,
          dia: 81,
          irregularPulse: false,
          arm: 'left',
          takenAt: { utcMs: 1_758_816_000_000 - 7_200_000, tzOffsetMin: 180 },
        },
      });
      const names = vi.mocked(broadcastToWindows).mock.calls.map((call) => call[0]);
      // Ни один форвардер не шлёт события ИИ: они приходят ТОЛЬКО от своих источников.
      expect(names.filter((name) => String(name).startsWith('ai:'))).toHaveLength(0);
    } finally {
      container.close();
    }
  });
});
