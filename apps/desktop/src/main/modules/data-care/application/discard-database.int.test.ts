/**
 * TASK-101 §5/§8/§13/§19: интеграционные тесты use case DiscardDatabase
 * («начать заново» recovery-экрана) — tmp-каталоги, реальная файловая система.
 *
 * Матрица (§19):
 *  1. happy: соединение закрыто (safe-close контейнера), файлы db/-wal/-shm
 *     удалены, перезапуск запланирован (relaunch-флаг), ключ/копии/логи НЕ тронуты
 *     (EC-14: копии пользователя остаются, §8 — unlink только db-подмножества);
 *  2. БД не открыта (recovery уже закрыл соединение): close — no-op, файлы всё
 *     равно удаляются (§8: повреждённые файлы не читаются, но удаляются честно);
 *  3. частичный сбой unlink (мок-EPERM, §19 — точка мок-сбоя): отказ WIPE/FAILED,
 *     relaunch НЕ запланирован (полуживое состояние хуже, §9 072);
 *  4.execute идёт под FileOpQueue (очередь сериализует файловые операции — §9 070).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { unsafeUnwrap } from '@hl/kernel';

import { FileOpQueue } from './file-op-queue.js';
import { DiscardDatabaseUseCase } from './discard-database.js';

/** Каталоги этой сессии — удаляются в afterAll (§14). */
const dirs: string[] = [];
const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Раскладывает файлы повреждённой БД (-wal/-shm по конвенции SQLite). */
const writeDbFiles = (dir: string, name: string): { dbPath: string; files: string[] } => {
  const dbPath = join(dir, name);
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const file of files) {
    writeFileSync(file, 'повреждённые-байты-101');
  }
  return { dbPath, files };
};

/** Харнес use case: safe-close-шпион, логгер-рекордер, очередь. */
const buildDiscard = (dbPath: string, options?: { unlink?: (path: string) => void }) => {
  const relaunch = vi.fn();
  const closeCurrentDb = vi.fn();
  const debug = vi.fn();
  const info = vi.fn();
  const error = vi.fn();
  const useCase = new DiscardDatabaseUseCase({
    dbPath,
    closeCurrentDb,
    logger: { debug, info, error },
    queue: new FileOpQueue(),
    relaunch,
    ...(options?.unlink === undefined ? {} : { unlink: options.unlink }),
  });
  return { useCase, relaunch, closeCurrentDb, debug, info, error };
};

describe('DiscardDatabaseUseCase — happy: unlink db/-wal/-shm + relaunch (TASK-101 §5/§8)', () => {
  it('файлы БД удалены, перезапуск запланирован, close вызван (checkpoint+close — точка контейнера)', async () => {
    const { dbPath, files } = writeDbFiles(newDir('hl-discard-happy-'), 'health-log.db');
    const harness = buildDiscard(dbPath);

    const result = await harness.useCase.execute();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.restarting).toBe(true);
    }
    expect(harness.closeCurrentDb).toHaveBeenCalledTimes(1);
    for (const file of files) {
      expect(existsSync(file)).toBe(false);
    }
    expect(harness.relaunch).toHaveBeenCalledTimes(1);
  });

  it('ключ, копии и логи НЕ тронуты (EC-14: копии пользователя остаются, §8)', async () => {
    const dir = newDir('hl-discard-keep-');
    const { dbPath } = writeDbFiles(dir, 'health-log.db');
    const keyPath = join(dir, 'vault.key');
    const backupPath = join(dir, 'backup.hlbackup');
    const logPath = join(dir, 'hl.log');
    writeFileSync(keyPath, 'ключ');
    writeFileSync(backupPath, 'копия');
    writeFileSync(logPath, 'лог');
    const harness = buildDiscard(dbPath);

    const result = await harness.useCase.execute();
    expect(result.ok).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(logPath)).toBe(true);
  });

  it('отсутствующие файлы (-wal/-shm после чистого закрытия) — не сбой (§9 072: цель достигнута)', async () => {
    const dir = newDir('hl-discard-absent-');
    const dbPath = join(dir, 'health-log.db');
    writeFileSync(dbPath, 'байты');
    const harness = buildDiscard(dbPath);

    const result = await harness.useCase.execute();
    expect(result.ok).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(harness.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe('DiscardDatabaseUseCase — сбои (§19)', () => {
  it('частичный сбой unlink → WIPE/FAILED, relaunch НЕ запланирован (полуживое состояние хуже, §9 072)', async () => {
    const { dbPath } = writeDbFiles(newDir('hl-discard-ep'), 'health-log.db');
    const harness = buildDiscard(dbPath, {
      unlink: (path: string) => {
        if (path === dbPath) {
          const error = new Error('EPERM: operation not permitted') as Error & { code: string };
          error.code = 'EPERM';
          throw error;
        }
      },
    });

    const result = await harness.useCase.execute();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('WIPE/FAILED');
    }
    expect(harness.relaunch).not.toHaveBeenCalled();
    expect(harness.error).toHaveBeenCalled();
  });
});

describe('DiscardDatabaseUseCase — очередь файловых операций (§9 070)', () => {
  it('execute сериализуется FileOpQueue (параллельный вызов с копией не пересекается)', async () => {
    const { dbPath } = writeDbFiles(newDir('hl-discard-queue-'), 'health-log.db');
    const order: string[] = [];
    const relaunch = vi.fn(() => order.push('relaunch'));
    const queue = new FileOpQueue();
    const useCase = new DiscardDatabaseUseCase({
      dbPath,
      closeCurrentDb: () => order.push('close'),
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      queue,
      relaunch,
    });
    const other = queue.run(() => {
      order.push('other');
      return Promise.resolve();
    });
    const promise = useCase.execute();
    await other;
    unsafeUnwrap(await promise);
    // Файловая операция discard — строго после уже стоявшей в очереди.
    expect(order.indexOf('other')).toBeLessThan(order.indexOf('close'));
  });
});
