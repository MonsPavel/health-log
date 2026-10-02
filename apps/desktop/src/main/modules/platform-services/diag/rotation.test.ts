/**
 * TASK-103 §5/§8/§19/§20: ротационные задачи scheduler'а — logs.rotate (удаление
 * >30-дневных лог-файлов; ротация 5×5 МБ уже на pino-roll TASK-010), events.rotate
 * (network_event >90 дней, app_event >180 дней — DELETE, арх. 04 §7).
 *
 *  - AC §20-4 (FixedClock): network_event 91 день удалён, 89 — цел; app_event
 *    порог 180: 181 день удалён, 179 — цел; границы «ровно на пороге» сохраняются
 *    (условие DELETE — строгое «старше порога»);
 *  - logs.rotate: старый mtime — удалён, свежий и граница — целы; блокировка
 *    unlink (Windows: открытый дескриптор активного лога) — задача не падает,
 *    warn-лог, остальные файлы удаляются (§13);
 *  - форма задач (§5 «интервал — при старте»): runOnStart: true, run → null
 *    (ротация — не напоминание);
 *  - отсутствующий каталог логов (чистая установка) — не отказ.
 *
 * БД — tmp-каталог, реальный стек openEncrypted → MigrationRunner(MIGRATIONS)
 * (§19, прецедент v5-network-event.int.test.ts); unlink — порт deps (§19 DI).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { unlink as fsUnlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREFS_SCHEMA, type Prefs } from '@hl/contracts';
import type { Instant } from '@hl/kernel';

import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type { JobCtx, JobDefinition } from '../../../shared/scheduler/scheduler.js';
import {
  APP_EVENT_RETENTION_DAYS,
  EVENTS_ROTATE_JOB_NAME,
  LOGS_RETENTION_DAYS,
  LOGS_ROTATE_JOB_NAME,
  NETWORK_EVENT_RETENTION_DAYS,
  createEventsRotateJob,
  createLogsRotateJob,
} from './rotation.js';

const DAY_MS = 86_400_000;
const NOW_MS = 1_759_400_000_000;

/** tmp-каталоги сессии (§14). */
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

/** Свежая зашифрованная БД на актуальной схеме (путь приложения §19). */
async function freshDb(name: string): Promise<EncryptedDatabase> {
  const dir = newDir('hl-diag-rot-');
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);
  return db;
}

// Windows: открытый дескриптор держит файл (прецедент container-passphrase.int.test.ts) —
// соединение закрывается ПОСЛЕ каждого кейса, tmp-каталоги чистятся в afterAll.
let openDb: EncryptedDatabase | undefined;
afterEach(() => {
  try {
    openDb?.close();
  } catch {
    // уже закрыт сценарием — не важно для очистки
  }
  openDb = undefined;
});

/** Вставляет строку network_event/app_event заданного возраста (дней до now). */
function seedNetworkEvent(db: EncryptedDatabase, id: string, ageDays: number): void {
  db.prepare(
    'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, NULL, ?)',
  ).run(id, 'updates.check', 'https://releases.example.com/latest', 'ok', NOW_MS - ageDays * DAY_MS);
}

function seedAppEvent(db: EncryptedDatabase, id: string, ageDays: number): void {
  db.prepare('INSERT INTO app_event (id, kind, payload_json, at_utc) VALUES (?, ?, ?, ?)').run(
    id,
    'app.start',
    '{}',
    NOW_MS - ageDays * DAY_MS,
  );
}

/** Контекст задачи (§7 074): FixedClock-момент, prefs — дефолт схемы (задачей не читается). */
function ctxAt(utcMs: number): JobCtx {
  const now: Instant = { utcMs, tzOffsetMin: 180 };
  return { prefs: PREFS_SCHEMA.parse({}) as Prefs, now };
}

describe('events.rotate — пороги 90/180 дней (TASK-103 §8/§19/AC §20-4)', () => {
  let db: EncryptedDatabase;
  let job: JobDefinition;
  let logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    db = await freshDb('rot-events.db');
    openDb = db;
    logger = { debug: vi.fn(), warn: vi.fn() };
    job = createEventsRotateJob({ db, logger });
    seedNetworkEvent(db, 'net-91', 91); // AC: 91 день — удалён
    seedNetworkEvent(db, 'net-90', 90); // граница «ровно 90» — цел (строгое «старше»)
    seedNetworkEvent(db, 'net-89', 89); // AC: 89 дней — цел
    seedNetworkEvent(db, 'net-1', 1);
    seedAppEvent(db, 'app-181', 181); // порог 180: старше — удалён
    seedAppEvent(db, 'app-180', 180); // граница «ровно 180» — цел
    seedAppEvent(db, 'app-179', 179); // моложе порога — цел
  });

  it('91 день удалён, 89 и граница 90 — целы; 181 удалён, 179 и граница 180 — целы', async () => {
    const action = await job.run(ctxAt(NOW_MS));
    expect(action).toBeNull(); // ротация — не напоминание (§5)

    const netIds = (db.prepare('SELECT id FROM network_event').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(netIds).not.toContain('net-91');
    expect(netIds).toContain('net-90');
    expect(netIds).toContain('net-89');
    expect(netIds).toContain('net-1');

    const appIds = (db.prepare('SELECT id FROM app_event').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(appIds).not.toContain('app-181');
    expect(appIds).toContain('app-180');
    expect(appIds).toContain('app-179');
  });

  it('пороговые константы §8: 90 (network_event) и 180 (app_event); задача — при старте', async () => {
    expect(NETWORK_EVENT_RETENTION_DAYS).toBe(90);
    expect(APP_EVENT_RETENTION_DAYS).toBe(180);
    expect(EVENTS_ROTATE_JOB_NAME).toBe('events.rotate');
    expect(job.name).toBe(EVENTS_ROTATE_JOB_NAME);
    expect(job.runOnStart).toBe(true);
    // Факт ротации в логе (§18): счётчики удалённого — наблюдаемость.
    await job.run(ctxAt(NOW_MS));
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('events.rotate'),
      expect.objectContaining({
        networkDeleted: expect.any(Number),
        appDeleted: expect.any(Number),
      }),
    );
  });

  it('идемпотентен: повторный прогон ничего не удаляет и не падает', async () => {
    await job.run(ctxAt(NOW_MS));
    const before = (db.prepare('SELECT COUNT(*) AS n FROM network_event').get() as { n: number }).n;
    await job.run(ctxAt(NOW_MS));
    const after = (db.prepare('SELECT COUNT(*) AS n FROM network_event').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('logs.rotate — удаление >30-дневных лог-файлов (TASK-103 §5/§19)', () => {
  let logsDir: string;
  let job: JobDefinition;
  let logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logsDir = newDir('hl-diag-rotlogs-');
    logger = { debug: vi.fn(), warn: vi.fn() };
    job = createLogsRotateJob({ logsDir, logger });
  });

  it('старше 30 дней удалён, свежий и граница 30 — целы', async () => {
    writeFileSync(join(logsDir, 'hl.0.log'), 'rotated-old\n');
    writeFileSync(join(logsDir, 'hl.1.log'), 'active-fresh\n');
    writeFileSync(join(logsDir, 'hl.2.log'), 'boundary\n');
    // mtime: 31 день (удалить), ровно 30 дней (граница — цел), 1 день (цел).
    utimesSync(join(logsDir, 'hl.0.log'), NOW_MS / 1000, (NOW_MS - 31 * DAY_MS) / 1000);
    utimesSync(join(logsDir, 'hl.2.log'), NOW_MS / 1000, (NOW_MS - 30 * DAY_MS) / 1000);
    utimesSync(join(logsDir, 'hl.1.log'), NOW_MS / 1000, (NOW_MS - DAY_MS) / 1000);

    expect(job.name).toBe(LOGS_ROTATE_JOB_NAME);
    expect(LOGS_RETENTION_DAYS).toBe(30);
    expect(job.runOnStart).toBe(true);
    const action = await job.run(ctxAt(NOW_MS));
    expect(action).toBeNull();

    expect(existsSync(join(logsDir, 'hl.0.log'))).toBe(false);
    expect(existsSync(join(logsDir, 'hl.2.log'))).toBe(true);
    expect(existsSync(join(logsDir, 'hl.1.log'))).toBe(true);
  });

  it('блокировка unlink (открытый дескриптор Windows) не валит задачу: warn, остальные удалены', async () => {
    writeFileSync(join(logsDir, 'hl.0.log'), 'locked-old\n');
    writeFileSync(join(logsDir, 'hl.1.log'), 'old-but-locked\n');
    utimesSync(join(logsDir, 'hl.0.log'), NOW_MS / 1000, (NOW_MS - 40 * DAY_MS) / 1000);
    utimesSync(join(logsDir, 'hl.1.log'), NOW_MS / 1000, (NOW_MS - 40 * DAY_MS) / 1000);

    // Порт unlink с отказом ТОЛЬКО на hl.1.log (симуляция EPERM активного лога).
    const failingUnlink = async (path: string): Promise<void> => {
      if (path.endsWith('hl.1.log')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      await fsUnlink(path);
    };
    const lockedJob = createLogsRotateJob({ logsDir, logger, unlink: failingUnlink });

    await expect(lockedJob.run(ctxAt(NOW_MS))).resolves.toBeNull();
    expect(existsSync(join(logsDir, 'hl.1.log'))).toBe(true); // заблокированный цел
    expect(existsSync(join(logsDir, 'hl.0.log'))).toBe(false); // остальные удалены
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('logs.rotate'),
      expect.objectContaining({ file: 'hl.1.log' }),
    );
  });

  it('отсутствующий каталог логов — не отказ (чистая установка)', async () => {
    const emptyJob = createLogsRotateJob({
      logsDir: join(newDir('hl-diag-nologs-'), 'nope'),
      logger,
    });
    await expect(emptyJob.run(ctxAt(NOW_MS))).resolves.toBeNull();
  });
});
