/**
 * TASK-066 §6/§9/§20: интеграционные тесты пула в composition root — контейнер
 * создаёт WorkerPool (2 воркера, ленивый) и закрывает его на will-quit ПОСЛЕ
 * закрытия БД (§9: оборвать с логом; потерянный PDF при закрытии допустим).
 *
 * AC3 (§15): IPC-ping во время CPU-задач пула < 50 мс — main не блокируется.
 * Замер по каналу каркаса (channels.dispatch 'app/ping'): в vitest нет Electron-IPC —
 * дескрипция честная: меряется latency хендлера main во время занятого пула
 * (в боевых условиях добавляется только транспорт preload↔main).
 *
 * AC4 (§9/§20): will-quit-симуляция — long-running job в воркере, container.close():
 * job отклоняется («terminated») без зависания, БД закрыта чисто (-wal/-shm нет),
 * повторный close — no-op.
 *
 * Хелперы (мок-vault, tmp-userData) повторяют container.int.test.ts: импорт
 * тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { API_ENVELOPE_VERSION } from '@hl/contracts';
import { AppError, FixedClock, type Result, ok } from '@hl/kernel';

import { buildContainer, DATABASE_FILENAME } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';
import { WorkerPool } from './shared/workerpool/pool.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Тестовые задачи пула — те же, что в pool.int.test.ts (§19). */
const TASKS_MODULE_URL = new URL(
  './shared/workerpool/__fixtures__/workerpool-tasks.mjs',
  import.meta.url,
);
/** Исходник воркера: дефолт entry пула — собранный worker.js из dist (прод), в vitest подставляем .ts. */
const WORKER_ENTRY_URL = new URL('./shared/workerpool/worker.ts', import.meta.url);

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-wp-int-'));

class MockVault implements KeyVault {
  private ensured = 0;

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({
      ok: true,
      value: { keyHex: KEY_HEX, created: this.ensured++ === 0 },
    });
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

const makeDeps = (dir: string) => ({
  userDataPath: dir,
  clock: new FixedClock(NOW_MS, TZ),
  vault: () => new MockVault(),
  // §6: создание пула в контейнере; тесты подставляют entry (.ts под type-stripping)
  // и модуль задач (прецедент переопределяемых фабрик каркаса).
  workerPool: { entryUrl: WORKER_ENTRY_URL, tasksModule: TASKS_MODULE_URL.href },
});

describe('container + WorkerPool (TASK-066 §6/§9/§20)', () => {
  it('контейнер собирает пул: job выполняется через container.workerPool', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer(makeDeps(dir));
    try {
      expect(container.workerPool).toBeInstanceOf(WorkerPool);
      await expect(container.workerPool.run('greet', { name: 'контейнер' })).resolves.toEqual({
        greeting: 'hello контейнер',
      });
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC3: IPC-ping во время CPU-задач пула < 50 мс (§15/§20)', { timeout: 15_000 }, async () => {
    const dir = newUserDataDir();
    const container = await buildContainer(makeDeps(dir));
    try {
      // Оба воркера заняты чистым CPU (без sleep) — как при активном PDF-рендере.
      const burning = Promise.all([
        container.workerPool.run('burn', { ms: 400 }),
        container.workerPool.run('burn', { ms: 400 }),
      ]);

      // Замер параллельно с CPU-задачами (§15): 30 вызовов ping через каркас.
      const latenciesMs: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const startedAtMs = performance.now();
        const envelope = await container.channels.dispatch({ channel: 'app/ping', payload: {} });
        latenciesMs.push(performance.now() - startedAtMs);
        expect(envelope).toEqual({
          v: API_ENVELOPE_VERSION,
          ok: true,
          data: { pong: true, ts: NOW_MS },
        });
      }
      const maxLatencyMs = Math.max(...latenciesMs);
      expect(maxLatencyMs).toBeLessThan(50);

      await burning; // CPU-задачи завершились штатно
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'AC4: will-quit — close() обрывает задачи пула после закрытия БД, не висит (§9/§20)',
    { timeout: 15_000 },
    async () => {
      const dir = newUserDataDir();
      const container = await buildContainer(makeDeps(dir));
      // Активная job (дождёмся фактического старта — progress 0) и следующая в очереди.
      const started = new Promise<void>((resolve) => {
        void container.workerPool
          .run(
            'sleepProgress',
            { ms: 5_000 },
            {
              onProgress: (p) => {
                if (p === 0) {
                  resolve();
                }
              },
            },
          )
          .catch(() => undefined);
      });
      const active = container.workerPool
        .run('sleepProgress', { ms: 5_000 })
        .catch((error: unknown) => error);
      const queued = container.workerPool
        .run('greet', { name: 'брошенная' })
        .catch((error: unknown) => error);
      await started;

      const closeStartedAtMs = performance.now();
      container.close(); // will-quit-симуляция (§8): sync, как боевой обработчик
      const closeMs = performance.now() - closeStartedAtMs;

      // Обрыв: обе job отклонены («terminated»), close не ждал завершения 5-секундной задачи.
      expect(closeMs).toBeLessThan(2_000);
      const activeOutcome = (await active) as Error;
      const queuedOutcome = (await queued) as Error;
      expect(String(activeOutcome.message)).toMatch(/terminated/);
      expect(String(queuedOutcome.message)).toMatch(/terminated/);

      // БД закрыта чисто (порядок §9: terminate после db.close).
      expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);
      expect(existsSync(join(dir, `${DATABASE_FILENAME}-wal`))).toBe(false);
      expect(existsSync(join(dir, `${DATABASE_FILENAME}-shm`))).toBe(false);
      // Идемпотентность close (повторный will-quit).
      expect(() => container.close()).not.toThrow();
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
