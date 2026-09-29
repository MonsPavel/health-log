/**
 * TASK-072 §19/§20: интеграционные тесты use case WipeAllData (tmp-userData,
 * реальный SQLCipher-стек openEncrypted + MigrationRunner; fixture-файлы всех
 * категорий созданы заранее — AC-1).
 *
 * Матрица (§19/§20):
 *  1. Plan (AC-1): полный список категорий — backups → logs → key → db (§19 РЕШЕНИЕ:
 *     БД последней), counts по факту, rendererLocalStorage; НИЧЕГО не удалено (§5:
 *     фаза plan не удаляет);
 *  2. Execute (AC-2): все файлы удалены (db/-wal/-shm, vault.key, logs/*, backups/*),
 *     relaunch запланирован; эмуляция перезапуска → новая БД создаётся, count=0
 *     (путь первого запуска TASK-023/025);
 *  3. Порядок (AC-3): мок-сбой unlink на логах (EPERM-stub — детерминированный «мок
 *     chmod-защиты»; физический chmod на Linux unlink не блокирует) → WIPE/FAILED
 *     с remaining, БД ПОСЛЕДНЯЯ — цела (открывается, записи на месте), backups уже
 *     удалены, relaunch НЕ планировался (§9: полуживое состояние хуже);
 *  4. Execute без plan (AC-4) → отказ (требование двухшаговости, §13), ничего не
 *     удалено, соединение БД живо;
 *  5. Состояние изменилось с момента plan (§9): файл из плана исчез / новый файл
 *     появился → отказ, ничего не удалено;
 *  6. Двойной execute (двойной клик, §13) → второй отказ (каждому execute — свой plan);
 *  7. §14/§18: лог каждой unlink — category+basename; полный путь userData в лог не
 *     попадает.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { AppError } from '@hl/kernel';

import { FileOpQueue } from './file-op-queue.js';
import {
  WIPE_FAILED_MESSAGE_KEY,
  WipeAllDataUseCase,
  type WipeAllDataResultValue,
  type WipePlan,
} from './wipe-all.js';

import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';

/** Тестовый ключ БД (32 байта) — один на сценарий (открытие до и после wipe). */
const KEY_HEX = randomBytes(32).toString('hex');
/** Имена fixture-файлов категорий (basename — наружу.renderer'а пути не нужны, §14). */
const DB_FILENAME = 'health-log.db';
const VAULT_KEY_FILENAME = 'vault.key';
const LOG_FILENAMES = ['hl.1.log', 'hl.2.log'];
const BACKUP_FILENAMES = ['health-log-backup-20260101T000000.hlbackup', 'pre-migration-v3.hlbackup'];

/** Каталоги этой сессии — удаляются в afterAll (§14); соединения закрываются первыми. */
const dirs: string[] = [];
const openDbs: EncryptedDatabase[] = [];
const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  // Windows: открытый дескриптор блокирует каталог для удаления — закрываем всё,
  // что тест оставил открытым (отказ/расхождение — чистая отмена без close).
  for (const db of openDbs) {
    if (db.open) {
      db.close();
    }
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Мета-сборщик логгера: все записи (проверки §18/§14; прецедент 071). */
interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}
const recordingLogger = (): {
  entries: LogEntry[];
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
} => {
  const entries: LogEntry[] = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    entries.push({ level, message, meta });
  };
  return {
    entries,
    logger: { debug: push('debug'), info: push('info'), error: push('error') },
  };
};

/**
 * tmp-userData фикстура (§19): реальная БД актуальной схемы с измерениями + файлы
 * всех категорий (vault.key, logs/*, backups/*) — план обязан перечислить всё (AC-1).
 */
interface WipeFixture {
  readonly userDataDir: string;
  readonly db: EncryptedDatabase;
  readonly dbPath: string;
  readonly vaultKeyPath: string;
  readonly logsDir: string;
  readonly backupsDir: string;
}
const buildWipeFixture = async (measurements: number): Promise<WipeFixture> => {
  const userDataDir = newDir('hl-wipe-ud-');
  const dbPath = join(userDataDir, DB_FILENAME);
  const db = openEncrypted(dbPath, KEY_HEX);
  openDbs.push(db);
  await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
  for (let i = 0; i < measurements; i += 1) {
    db.prepare(
      "INSERT INTO bp_measurement (id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, source, created_at_utc, updated_at_utc) VALUES (?, 'seed-profile-0001', ?, 180, 120, 80, 70, 0, 'left', 'manual', ?, ?)",
    ).run(`m-${i}-${randomBytes(4).toString('hex')}`, 1_758_816_000_000 + i, 1_758_816_000_000, 1_758_816_000_000);
  }
  // Ключ + logs/* + backups/* (fixture-файлы всех категорий, AC-1).
  writeFileSync(join(userDataDir, VAULT_KEY_FILENAME), '{"v":1,"wrapped":"…"}');
  const logsDir = join(userDataDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  for (const name of LOG_FILENAMES) {
    writeFileSync(join(logsDir, name), `log ${name}`);
  }
  const backupsDir = join(userDataDir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  for (const name of BACKUP_FILENAMES) {
    writeFileSync(join(backupsDir, name), 'HLBK1-fixture');
  }
  return { userDataDir, db, dbPath, vaultKeyPath: join(userDataDir, VAULT_KEY_FILENAME), logsDir, backupsDir };
};

/** Счётчик измерений открытой БД. */
const countRows = (db: EncryptedDatabase): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM bp_measurement').get() as { n: number }).n;

/** Ожидаемый план фикстуры: порядок §19 — backups → logs → key → db (БД последней). */
const expectedPlanFiles = (): { path: string; category: string }[] => [
  ...BACKUP_FILENAMES.map((path) => ({ path, category: 'backups' })),
  ...LOG_FILENAMES.map((path) => ({ path, category: 'logs' })),
  { path: VAULT_KEY_FILENAME, category: 'key' },
  { path: `${DB_FILENAME}-wal`, category: 'db' },
  { path: `${DB_FILENAME}-shm`, category: 'db' },
  { path: DB_FILENAME, category: 'db' },
];

/** Опции сборки use case: подмена unlink (мок-сбой §19). */
interface HarnessOptions {
  /** Точка мок-сбоя (§19); по умолчанию — реальный unlinkSync. */
  readonly unlink?: (path: string) => void;
}
interface Harness {
  readonly fixture: WipeFixture;
  readonly useCase: WipeAllDataUseCase;
  readonly entries: LogEntry[];
  readonly relaunch: ReturnType<typeof vi.fn>;
}
const buildWipeHarness = (fixture: WipeFixture, options: HarnessOptions = {}): Harness => {
  const { entries, logger } = recordingLogger();
  const relaunch = vi.fn();
  const useCase = new WipeAllDataUseCase({
    db: fixture.db,
    closeCurrentDb: () => {
      fixture.db.pragma('wal_checkpoint(TRUNCATE)');
      fixture.db.close();
    },
    dbPath: fixture.dbPath,
    vaultKeyPath: fixture.vaultKeyPath,
    logsDir: fixture.logsDir,
    backupsDir: fixture.backupsDir,
    logger,
    queue: new FileOpQueue(),
    relaunch,
    ...(options.unlink === undefined ? {} : { unlink: options.unlink }),
  });
  return { fixture, useCase, entries, relaunch };
};

/** Сужение значения фазы plan (иначе — ошибка сценария теста). */
const expectPlan = (value: WipeAllDataResultValue): WipePlan => {
  if (!('plan' in value)) {
    throw new Error('ожидался план стирания (phase: plan)');
  }
  return value.plan;
};

/** Сужение значения фазы execute (иначе — ошибка сценария теста). */
const expectRestarting = (value: WipeAllDataResultValue): true => {
  if (!('restarting' in value)) {
    throw new Error('ожидался запланированный перезапуск (phase: execute)');
  }
  return value.restarting;
};

/** Все файлы фикстуры (полные пути) — для проверок «удалено/на месте». */
const fixtureFilePaths = (fixture: WipeFixture): string[] => [
  ...LOG_FILENAMES.map((name) => join(fixture.logsDir, name)),
  ...BACKUP_FILENAMES.map((name) => join(fixture.backupsDir, name)),
  fixture.vaultKeyPath,
  `${fixture.dbPath}-wal`,
  `${fixture.dbPath}-shm`,
  fixture.dbPath,
];

describe('WipeAllDataUseCase — plan: полный список категорий, ничего не удаляет (AC-1, §5)', () => {
  it('план перечисляет backups+logs+key+db в порядке §19, counts — факт; файлы на месте', async () => {
    const fixture = await buildWipeFixture(3);
    try {
      const harness = buildWipeHarness(fixture);
      const result = await harness.useCase.execute({ phase: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const plan = expectPlan(result.value);
      expect(plan.files).toEqual(expectedPlanFiles());
      // Все четыре категории присутствуют (AC-1).
      expect(new Set(plan.files.map((file) => file.category))).toEqual(
        new Set(['db', 'key', 'logs', 'backups']),
      );
      expect(plan.counts).toEqual({ measurements: 3 });
      expect(plan.rendererLocalStorage).toBe(true);
      // §5: фаза plan НЕ удаляет — все fixture-файлы на месте, relaunch не планировался.
      for (const path of fixtureFilePaths(fixture)) {
        expect(existsSync(path)).toBe(true);
      }
      expect(harness.relaunch).not.toHaveBeenCalled();
      expect(countRows(fixture.db)).toBe(3);
    } finally {
      if (fixture.db.open) {
        fixture.db.close();
      }
    }
  });
});

describe('WipeAllDataUseCase — execute: всё удалено, relaunch запланирован (AC-2, §5)', () => {
  it('plan → execute: файлов нет; эмуляция перезапуска — новая БД, count=0', async () => {
    const fixture = await buildWipeFixture(2);
    const harness = buildWipeHarness(fixture);
    const planResult = await harness.useCase.execute({ phase: 'plan' });
    expect(planResult.ok).toBe(true);

    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(true);
    if (!execResult.ok) {
      return;
    }
    expect(expectRestarting(execResult.value)).toBe(true);
    expect(harness.relaunch).toHaveBeenCalledTimes(1);

    // Все файлы категорий удалены (каталоги могут остаться пустыми — §5: unlink файлов).
    for (const path of fixtureFilePaths(fixture)) {
      expect(existsSync(path)).toBe(false);
    }

    // Эмуляция перезапуска (§19): путь первого запуска TASK-023/025 — новая БД +
    // ключ создаются автоматически; схема поднимается runner'ом; записей 0.
    const fresh = openEncrypted(harness.fixture.dbPath, KEY_HEX);
    try {
      await new MigrationRunner({ migrations: MIGRATIONS }).migrate(fresh);
      expect(countRows(fresh)).toBe(0);
    } finally {
      fresh.close();
    }
  });
});

describe('WipeAllDataUseCase — частичный сбой unlink: БД последняя, цела (AC-3, §9/§19)', () => {
  it('EPERM на первом log-файле → WIPE/FAILED {remaining}, backups удалены, БД открывается, relaunch нет', async () => {
    const fixture = await buildWipeFixture(2);
    // Мок «chmod-защиты» (§19): детерминированный EPERM-stub на первый log-файл.
    const protectedLog = join(fixture.logsDir, LOG_FILENAMES[0] as string);
    const harness = buildWipeHarness(fixture, {
      unlink: (path: string) => {
        if (path === protectedLog) {
          throw Object.assign(new Error('мок: файл защищён (EPERM, §19)'), { code: 'EPERM' });
        }
        unlinkSync(path);
      },
    });
    const planResult = await harness.useCase.execute({ phase: 'plan' });
    expect(planResult.ok).toBe(true);

    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error).toBeInstanceOf(AppError);
      expect(execResult.error.code).toBe('WIPE/FAILED');
      expect(execResult.error.messageKey).toBe(WIPE_FAILED_MESSAGE_KEY);
      // Что осталось (§11): сбойнувший log + второй log + key + db (wal/shm удалены
      // SQLite при закрытии; остальные категории ещё не удалялись).
      const remaining = (execResult.error.cause as { remaining: string[] }).remaining;
      expect(remaining).toEqual([
        LOG_FILENAMES[0],
        LOG_FILENAMES[1],
        VAULT_KEY_FILENAME,
        DB_FILENAME,
      ]);
      expect(execResult.error.params).toEqual({ remainingCount: remaining.length });
    }

    // Порядок §19: backups (до logs) — уже удалены; сбойнувшие logs/key/db — на месте.
    for (const name of BACKUP_FILENAMES) {
      expect(existsSync(join(fixture.backupsDir, name))).toBe(false);
    }
    for (const name of LOG_FILENAMES) {
      expect(existsSync(join(fixture.logsDir, name))).toBe(true);
    }
    expect(existsSync(fixture.vaultKeyPath)).toBe(true);
    expect(existsSync(fixture.dbPath)).toBe(true);
    // §9: полуживое состояние хуже — НЕ перезапускать; БД цела и читаема (AC-3).
    expect(harness.relaunch).not.toHaveBeenCalled();
    const reopened = openEncrypted(fixture.dbPath, KEY_HEX);
    try {
      expect(countRows(reopened)).toBe(2);
    } finally {
      reopened.close();
    }
  });
});

describe('WipeAllDataUseCase — execute без plan: отказ двухшаговости (AC-4, §13)', () => {
  it('execute первым вызовом → WIPE/FAILED; ничего не удалено, соединение живо, relaunch нет', async () => {
    const fixture = await buildWipeFixture(1);
    const harness = buildWipeHarness(fixture);

    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error).toBeInstanceOf(AppError);
      expect(execResult.error.code).toBe('WIPE/FAILED');
      expect(execResult.error.messageKey).toBe(WIPE_FAILED_MESSAGE_KEY);
    }

    for (const path of fixtureFilePaths(fixture)) {
      expect(existsSync(path)).toBe(true);
    }
    // Отказ ДО закрытия БД — соединение работает (чистая отмена).
    expect(countRows(fixture.db)).toBe(1);
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('после plan → plan: execute удаляет по ПОСЛЕДНЕМУ плану (перезапись — не отказ)', async () => {
    const fixture = await buildWipeFixture(1);
    const harness = buildWipeHarness(fixture);
    expect((await harness.useCase.execute({ phase: 'plan' })).ok).toBe(true);
    expect((await harness.useCase.execute({ phase: 'plan' })).ok).toBe(true);
    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(true);
    expect(harness.relaunch).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.dbPath)).toBe(false);
  });
});

describe('WipeAllDataUseCase — состояние изменилось с момента plan (§9)', () => {
  it('файл из плана исчез → отказ WIPE/FAILED, ничего не удалено', async () => {
    const fixture = await buildWipeFixture(1);
    const harness = buildWipeHarness(fixture);
    expect((await harness.useCase.execute({ phase: 'plan' })).ok).toBe(true);

    // Один backup-файл удалён вручную между фазами — расхождение.
    rmSync(join(fixture.backupsDir, BACKUP_FILENAMES[0] as string));

    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error.code).toBe('WIPE/FAILED');
    }
    for (const path of fixtureFilePaths(fixture).filter((path) => path !== join(fixture.backupsDir, BACKUP_FILENAMES[0] as string))) {
      expect(existsSync(path)).toBe(true);
    }
    expect(harness.relaunch).not.toHaveBeenCalled();
    expect(countRows(fixture.db)).toBe(1);
  });

  it('новый файл появился после plan → отказ (строгая сверка: появился = расхождение)', async () => {
    const fixture = await buildWipeFixture(1);
    const harness = buildWipeHarness(fixture);
    expect((await harness.useCase.execute({ phase: 'plan' })).ok).toBe(true);

    // Ротация лога между фазами: новый файл в logs.
    writeFileSync(join(fixture.logsDir, 'hl.3.log'), 'новый');

    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error.code).toBe('WIPE/FAILED');
    }
    for (const path of fixtureFilePaths(fixture)) {
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(join(fixture.logsDir, 'hl.3.log'))).toBe(true);
    expect(harness.relaunch).not.toHaveBeenCalled();
  });
});

describe('WipeAllDataUseCase — двойной execute (двойной клик, §13)', () => {
  it('повторный execute после успешного → отказ (каждому execute — свой plan)', async () => {
    const fixture = await buildWipeFixture(1);
    const harness = buildWipeHarness(fixture);
    expect((await harness.useCase.execute({ phase: 'plan' })).ok).toBe(true);
    expect((await harness.useCase.execute({ phase: 'execute' })).ok).toBe(true);
    expect(harness.relaunch).toHaveBeenCalledTimes(1);

    const second = await harness.useCase.execute({ phase: 'execute' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('WIPE/FAILED');
    }
    // Второй отказ не планирует второй перезапуск.
    expect(harness.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe('WipeAllDataUseCase — лог (§18/§14: category+basename, без полных путей)', () => {
  it('каждая unlink отражена category+basename; полный путь userData в лог не попадает', async () => {
    const fixture = await buildWipeFixture(1);
    const harness = buildWipeHarness(fixture);
    expect((await harness.useCase.execute({ phase: 'plan' })).ok).toBe(true);
    const execResult = await harness.useCase.execute({ phase: 'execute' });
    expect(execResult.ok).toBe(true);

    // §18: лог каждой unlink — category + basename (аудиторский след поддержки).
    // Фактические unlink — всё, кроме -wal/-shm: SQLite удаляет их сам при
    // закрытии соединения (шаг 3 execute) — в плане они есть, к unlink их уже
    // нет ('wipe file already absent', debug).
    const deleted = harness.entries.filter((entry) => entry.message === 'wipe file deleted');
    const realFiles = expectedPlanFiles().filter(
      ({ path }) => path !== `${DB_FILENAME}-wal` && path !== `${DB_FILENAME}-shm`,
    );
    expect(deleted.map((entry) => [entry.meta?.['category'], entry.meta?.['file']])).toEqual(
      realFiles.map(({ category, path }) => [category, path]),
    );
    const absent = harness.entries
      .filter((entry) => entry.message === 'wipe file already absent')
      .map((entry) => entry.meta?.['file']);
    expect(absent).toEqual([`${DB_FILENAME}-wal`, `${DB_FILENAME}-shm`]);
    // §14: полный путь (userData содержит имя Windows-пользователя) — не в логе.
    const dumped = JSON.stringify(harness.entries);
    expect(dumped).not.toContain(fixture.userDataDir);
    expect(dumped).toContain('wipe plan');
    expect(dumped).toContain('wipe success');
  });
});
