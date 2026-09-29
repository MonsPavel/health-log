/**
 * TASK-071 §19/§20: интеграционные тесты use case RestoreBackup (tmp-каталоги,
 * реальный SQLCipher-стек openEncrypted, реальный MigrationRunner и CreateBackup).
 *
 * Матрица (§19/§20):
 *  1. Happy (равная схема): план (equal, replaces-current, счётчики) → execute →
 *     подмена файла БД расшифрованным снапшотом, -wal/-shm удалены, перезапуск
 *     запланирован (relaunch-флаг, §9); после перезапуска счётчик записей равен
 *     манифесту (AC-1); страховка — шифрованный контейнер в tmp + флаг-файл (§14),
 *     открытого текста снапшота на диске нет;
 *  2. копия старее → план schemaDelta=older + предупреждение older-than-current (§13:
 *     counts-факт «в копии 1, сейчас 2»); execute разрешён (миграции при старте);
 *  3. пустая текущая БД → предупреждение replaces-current всё равно показывается (§13);
 *  4. копия новее → отказ BACKUP/DB_NEWER ДО закрытия текущей БД — и в plan, и в
 *     execute; текущие данные работают (AC-2);
 *  5. неверный пароль → BACKUP/WRONG_PASSPHRASE, дважды — не деградирует, БД не
 *     тронута (AC-3);
 *  6. битый sha256 → отказ целостности BACKUP/INTEGRITY (AC-4);
 *  7. откат-страховка: сбой расшифровки ПОСЛЕ закрытия БД (мок readContainer) →
 *     текущая БД возвращена и работоспособна (AC-5); relaunch запланирован
 *     (соединение закрыто — приложению нужен перезапуск, §9);
 *  8. execute без plan-фазы: самодостаточен (валидный файл → restarting) и
 *     отказывает на невалидном файле, не трогая текущую БД (AC-6);
 *  9. пустой пароль команды → VALIDATION/FAILED (прецедент 070 §13);
 * 10. cleanupRestoreSafetyCopy: флаг-файл → удаление каталога страховки при
 *     успешном старте (§14); без флага — no-op;
 * 11. §14: пароль и пути не попадают в лог (redact-страховка).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { AppError, FixedClock } from '@hl/kernel';

import { BackupIntegrityError } from '../adapters/backup-crypto.js';
import {
  BackupContainerCodec,
  type BackupContainerCodecOptions,
} from '../adapters/backup-container.js';
import type { BackupCrypto } from './ports/backup-crypto.js';
import { CreateBackupUseCase } from './create-backup.js';
import { FileOpQueue } from './file-op-queue.js';
import { cleanupRestoreSafetyCopy, RestoreBackupUseCase } from './restore-backup.js';

import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner, type Migration } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';

/** Фиксированное «сейчас» FixedClock — конвенция контрактных наборов. */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
/** Тестовый ключ БД (32 байта) — один на сценарий (копия снимается с той же БД). */
const KEY_HEX = randomBytes(32).toString('hex');
/** Пароль копии в happy-сценарии. */
const PASSPHRASE = 'пароль-копии-071';
/** Версия приложения (сборка use case'ов). */
const APP_VERSION = 'test-0.7.1';

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

/** Кодек с минимальными параметрами Argon2id (скорость набора; боевые — в контейнере). */
const newCodec = (options?: BackupContainerCodecOptions): BackupContainerCodec =>
  new BackupContainerCodec({
    argon2Params: { iterations: 1, memoryKib: 64, parallelism: 1 },
    ...options,
  });

/** Мета-сборщик логгера: все записи (проверки §18/§14). */
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
 * Свежая БД актуальной схемы (файл в tmp, реальный openEncrypted + MigrationRunner
 * с реестром приложения) — прецедент create-backup.int.test.
 */
const openFreshDb = (name: string): { db: EncryptedDatabase; file: string } => {
  const file = join(newDir('hl-restore-db-'), name);
  const db = openEncrypted(file, KEY_HEX);
  void new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
  return { db, file };
};

/** Вставляет count измерений сид-профилю (сырой SQL, прецедент container.int.test). */
const insertMeasurements = (db: EncryptedDatabase, count: number): void => {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      "INSERT INTO bp_measurement (id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, source, created_at_utc, updated_at_utc) VALUES (?, 'seed-profile-0001', ?, 180, 120, 80, 70, 0, 'left', 'manual', ?, ?)",
    ).run(`m-${i}-${randomBytes(4).toString('hex')}`, NOW_MS + i, NOW_MS, NOW_MS);
  }
};

/** Счётчик измерений открытой БД. */
const countRows = (db: EncryptedDatabase): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM bp_measurement').get() as { n: number }).n;

/** Создаёт РЕАЛЬНУЮ копию БД паролем (CreateBackupUseCase, mode ask) — путь файла. */
const createBackupFile = async (
  db: EncryptedDatabase,
  passphrase: string,
  name: string,
): Promise<string> => {
  const dir = newDir('hl-restore-src-');
  const targetPath = join(dir, name);
  const create = new CreateBackupUseCase({
    db,
    clock: new FixedClock(NOW_MS, TZ),
    logger: recordingLogger().logger,
    crypto: newCodec(),
    fileSaver: { save: vi.fn().mockResolvedValue(targetPath) },
    queue: new FileOpQueue(),
    backupsDir: newDir('hl-restore-backups-'),
    appVersion: APP_VERSION,
    snapshotTmpRoot: newDir('hl-restore-snap-'),
  });
  const result = await create.execute({ mode: 'ask', passphrase });
  if (!result.ok) {
    throw new Error(`сценарная копия не создалась: ${result.error.code}`);
  }
  return targetPath;
};

/** Собранный use case восстановления (§19: подстановочные зависимости вокруг реального кодека). */
interface HarnessOptions {
  /** Подмена криптопорта (мок-сбой расшифровки, §19); по умолчанию реальный кодек. */
  readonly crypto?: BackupCrypto;
  /** Подмена verifyDatabaseOpens (по умолчанию реальный openEncrypted + close). */
  readonly verifyDatabaseOpens?: (path: string) => void;
}
interface Harness {
  readonly dbPath: string;
  readonly safetyFlagPath: string;
  readonly safetyTmpRoot: string;
  readonly useCase: RestoreBackupUseCase;
  readonly entries: LogEntry[];
  readonly relaunch: ReturnType<typeof vi.fn>;
}
const buildRestoreHarness = (
  db: EncryptedDatabase,
  dbFile: string,
  options: HarnessOptions = {},
): Harness => {
  const safetyTmpRoot = newDir('hl-restore-safety-root-');
  const safetyFlagPath = join(newDir('hl-restore-flag-'), 'restore-safety.json');
  const { entries, logger } = recordingLogger();
  const relaunch = vi.fn();
  const useCase = new RestoreBackupUseCase({
    currentDb: db,
    closeCurrentDb: () => {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    },
    dbPath: dbFile,
    verifyDatabaseOpens:
      options.verifyDatabaseOpens ??
      ((path: string) => {
        const probe = openEncrypted(path, KEY_HEX);
        probe.close();
      }),
    crypto: options.crypto ?? newCodec(),
    logger,
    queue: new FileOpQueue(),
    relaunch,
    safetyFlagPath,
    safetyTmpRoot,
    clock: new FixedClock(NOW_MS, TZ),
    appVersion: APP_VERSION,
  });
  return { dbPath: dbFile, safetyFlagPath, safetyTmpRoot, useCase, entries, relaunch };
};

describe('RestoreBackupUseCase — happy: равная схема, подмена + relaunch (AC-1, §19)', () => {
  it('plan → execute: файл БД заменён снапшотом копии, перезапуск запланирован, страховка зашифрована', async () => {
    const { db, file: dbFile } = openFreshDb('happy.sqlite');
    try {
      insertMeasurements(db, 3);
      const backupPath = await createBackupFile(db, PASSPHRASE, 'happy.hlbackup');
      const harness = buildRestoreHarness(db, dbFile);

      // Фаза 1: план (confirmed: false).
      const planResult = await harness.useCase.execute({
        file: backupPath,
        passphrase: PASSPHRASE,
        confirmed: false,
      });
      expect(planResult.ok).toBe(true);
      if (!planResult.ok) {
        return;
      }
      const plan = planResult.value.plan;
      expect(plan.schemaDelta).toBe('equal');
      expect(plan.warnings).toEqual(['replaces-current']);
      expect(plan.manifest.schemaVersion).toBe(MIGRATIONS.at(-1)?.version);
      expect(plan.manifest.counts).toEqual({ measurements: 3 });
      expect(plan.currentCounts).toEqual({ measurements: 3 });
      // execute ещё не вызывался: БД не закрыта, relaunch не запланирован.
      expect(harness.relaunch).not.toHaveBeenCalled();
      expect(countRows(db)).toBe(3);

      // Фаза 2: execute (confirmed: true).
      const execResult = await harness.useCase.execute({
        file: backupPath,
        passphrase: PASSPHRASE,
        confirmed: true,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) {
        return;
      }
      expect(execResult.value.restarting).toBe(true);
      // §9: перезапуск запланирован (контейнер откладывает фактический relaunch на 500 мс).
      expect(harness.relaunch).toHaveBeenCalledTimes(1);

      // AC-1: файл БД заменён снапшотом копии — свежее соединение видит данные копии.
      expect(existsSync(`${dbFile}-wal`)).toBe(false);
      expect(existsSync(`${dbFile}-shm`)).toBe(false);
      const reopened = openEncrypted(dbFile, KEY_HEX);
      try {
        expect(countRows(reopened)).toBe(3);
      } finally {
        reopened.close();
      }

      // Страховка (§14): зашифрованный контейнер в tmp + флаг-файл; открытого
      // текста снапшота на диске нет.
      expect(existsSync(harness.safetyFlagPath)).toBe(true);
      const flag = JSON.parse(readFileSync(harness.safetyFlagPath, 'utf8')) as {
        dir: string;
        createdAtUtc: number;
      };
      expect(typeof flag.dir).toBe('string');
      expect(existsSync(flag.dir)).toBe(true);
      expect(readdirSync(flag.dir)).toEqual(['pre-restore.hlbackup']);
      // Контейнер страховки расшифровывается тем же паролем (защита данных, §14).
      const codec = newCodec();
      const header = await codec.readHeader({
        containerPath: join(flag.dir, 'pre-restore.hlbackup'),
      });
      expect(header.manifest.counts).toEqual({ measurements: 3 });

      // §18: лог фактов — plan и success, без путей и пароля (§14).
      expect(
        harness.entries.some(
          (entry) => entry.message === 'restore plan' && entry.meta?.['schemaDelta'] === 'equal',
        ),
      ).toBe(true);
      expect(harness.entries.some((entry) => entry.message === 'restore success')).toBe(true);
      const dumped = JSON.stringify(harness.entries);
      expect(dumped).not.toContain(PASSPHRASE);
      expect(dumped).not.toContain(dbFile);
      expect(dumped).not.toContain(flag.dir);
    } finally {
      // execute закрыл соединение сам (closeCurrentDb); повторный close безопасен? —
      // нет: закрываем только если ещё открыт (план упал — закрываем тестом).
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — копия старее (§13/§19: план older, execute разрешён)', () => {
  it('plan: schemaDelta=older + older-than-current, счётчики — факт; execute заменяет БД', async () => {
    // Копия со «старой» схемой v1 (свой реестр миграций) — реальный путь создания.
    // meta создаёт сам runner (TASK-024 §8), schema_version=1 пишет он же.
    const legacy: Migration[] = [
      {
        version: 1,
        up: (database) => {
          database.exec('CREATE TABLE bp_measurement (id TEXT PRIMARY KEY)');
        },
      },
    ];
    const legacyDb = openEncrypted(join(newDir('hl-restore-legacy-'), 'legacy.sqlite'), KEY_HEX);
    try {
      void new MigrationRunner({ migrations: legacy }).migrate(legacyDb);
      legacyDb.prepare(
        "INSERT INTO bp_measurement (id) VALUES ('legacy-1')",
      ).run();
      const backupPath = await createBackupFile(legacyDb, PASSPHRASE, 'legacy.hlbackup');

      // Текущая БД — актуальной схемы v4 с ДВУМЯ записями (counts-предупреждение §13).
      const { db, file: dbFile } = openFreshDb('current.sqlite');
      try {
        insertMeasurements(db, 2);
        const harness = buildRestoreHarness(db, dbFile);

        const planResult = await harness.useCase.execute({
          file: backupPath,
          passphrase: PASSPHRASE,
          confirmed: false,
        });
        expect(planResult.ok).toBe(true);
        if (!planResult.ok) {
          return;
        }
        const plan = planResult.value.plan;
        expect(plan.schemaDelta).toBe('older');
        expect(plan.warnings).toEqual(['replaces-current', 'older-than-current']);
        expect(plan.manifest.schemaVersion).toBe(1);
        expect(plan.manifest.counts).toEqual({ measurements: 1 });
        // §13: «в копии 120 записей, сейчас 350» — факт, не оценка.
        expect(plan.currentCounts).toEqual({ measurements: 2 });

        // Execute разрешён: миграции применятся при старте своим runner'ом (§13).
        const execResult = await harness.useCase.execute({
          file: backupPath,
          passphrase: PASSPHRASE,
          confirmed: true,
        });
        expect(execResult.ok).toBe(true);
        if (!execResult.ok) {
          return;
        }
        const reopened = openEncrypted(dbFile, KEY_HEX);
        try {
          expect(countRows(reopened)).toBe(1);
        } finally {
          reopened.close();
        }
      } finally {
        if (db.open) {
          db.close();
        }
      }
    } finally {
      if (legacyDb.open) {
        legacyDb.close();
      }
    }
  });

  it('§13: пустая текущая БД → replaces-current всё равно показывается (согласованность)', async () => {
    const { db, file: dbFile } = openFreshDb('empty-current.sqlite');
    try {
      const backupPath = await createBackupFile(db, PASSPHRASE, 'empty-current.hlbackup');
      // Отдельная пустая текущая БД (0 записей) — предупреждение замены неизменно.
      const current = openFreshDb('empty-target.sqlite');
      try {
        insertMeasurements(current.db, 0);
        const harness = buildRestoreHarness(current.db, current.file);
        const planResult = await harness.useCase.execute({
          file: backupPath,
          passphrase: PASSPHRASE,
          confirmed: false,
        });
        expect(planResult.ok).toBe(true);
        if (!planResult.ok) {
          return;
        }
        expect(planResult.value.plan.currentCounts).toEqual({ measurements: 0 });
        expect(planResult.value.plan.warnings).toEqual(['replaces-current']);
      } finally {
        if (current.db.open) {
          current.db.close();
        }
      }
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — копия новее: отказ DB_NEWER до касания данных (AC-2)', () => {
  /** Собирает самосогласованный контейнер с манифестом schemaVersion=99 (codec напрямую). */
  const craftNewerCopy = async (payloadPath: string, destinationPath: string): Promise<void> => {
    const codec = newCodec();
    const { kdf, contentKey } = await codec.prepareKey({ kind: 'passphrase', passphrase: PASSPHRASE });
    const payload = readFileSync(payloadPath);
    const manifest = {
      formatVersion: 1,
      schemaVersion: 99,
      appVersion: 'future-9.9.9',
      createdAtUtc: NOW_MS,
      counts: { measurements: 5 },
      dbSha256: createHash('sha256').update(payload).digest('hex'),
      kdf,
    };
    await codec.writeContainer({
      manifestJson: Buffer.from(JSON.stringify(manifest), 'utf8'),
      contentKey,
      snapshotPath: payloadPath,
      destinationPath,
    });
  };

  it('plan → err BACKUP/DB_NEWER с params; execute → тот же отказ; текущая БД работает', async () => {
    const { db, file: dbFile } = openFreshDb('newer.sqlite');
    try {
      insertMeasurements(db, 4);
      // Пayload — байты живой БД (содержимое не важно: отказ по схеме, до расшифровки).
      const newerCopyPath = join(newDir('hl-restore-craft-'), 'newer.hlbackup');
      await craftNewerCopy(dbFile, newerCopyPath);

      const harness = buildRestoreHarness(db, dbFile);

      for (const confirmed of [false, true]) {
        const result = await harness.useCase.execute({
          file: newerCopyPath,
          passphrase: PASSPHRASE,
          confirmed,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AppError);
          expect(result.error.code).toBe('BACKUP/DB_NEWER');
          expect(result.error.messageKey).toBe('errors.BACKUP_DB_NEWER');
          expect(result.error.params).toEqual({ schemaVersion: 99 });
        }
      }

      // AC-2: отказ ДО закрытия текущей БД — соединение живо, данные работают;
      // страховка/флаг/перезапуск не создавались.
      expect(countRows(db)).toBe(4);
      expect(harness.relaunch).not.toHaveBeenCalled();
      expect(existsSync(harness.safetyFlagPath)).toBe(false);
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — неверный пароль (AC-3, §19: дважды — не деградирует)', () => {
  it('два попытки → BACKUP/WRONG_PASSPHRASE, БД не тронута', async () => {
    const { db, file: dbFile } = openFreshDb('wrong-pass.sqlite');
    try {
      insertMeasurements(db, 2);
      const backupPath = await createBackupFile(db, PASSPHRASE, 'wrong-pass.hlbackup');
      const harness = buildRestoreHarness(db, dbFile);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await harness.useCase.execute({
          file: backupPath,
          passphrase: 'совсем-другой-пароль',
          confirmed: false,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AppError);
          expect(result.error.code).toBe('BACKUP/WRONG_PASSPHRASE');
          expect(result.error.messageKey).toBe('errors.BACKUP_WRONG_PASSPHRASE');
        }
      }

      // БД не тронута: соединение живо, страховка не создавалась (GCM-неудача в plan).
      expect(countRows(db)).toBe(2);
      expect(existsSync(harness.safetyFlagPath)).toBe(false);
      expect(harness.relaunch).not.toHaveBeenCalled();
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — битый sha256: отказ целостности (AC-4)', () => {
  it('самосогласованный контейнер с чужим dbSha256 → BACKUP/INTEGRITY', async () => {
    const { db, file: dbFile } = openFreshDb('bad-sha.sqlite');
    try {
      insertMeasurements(db, 1);
      // Контейнер собирается кодеком напрямую: манифест валиден по форме, но
      // dbSha256 не совпадает с sha256(payload) — GCM проходит, sha-проверка нет.
      const codec = newCodec();
      const { kdf, contentKey } = await codec.prepareKey({
        kind: 'passphrase',
        passphrase: PASSPHRASE,
      });
      const payloadPath = join(newDir('hl-restore-craft-'), 'payload.db');
      writeFileSync(payloadPath, readFileSync(dbFile));
      const destinationPath = join(newDir('hl-restore-craft-'), 'bad-sha.hlbackup');
      const manifest = {
        formatVersion: 1,
        schemaVersion: MIGRATIONS.at(-1)?.version ?? 0,
        appVersion: APP_VERSION,
        createdAtUtc: NOW_MS,
        counts: { measurements: 1 },
        dbSha256: 'b'.repeat(64),
        kdf,
      };
      await codec.writeContainer({
        manifestJson: Buffer.from(JSON.stringify(manifest), 'utf8'),
        contentKey,
        snapshotPath: payloadPath,
        destinationPath,
      });

      const harness = buildRestoreHarness(db, dbFile);
      const result = await harness.useCase.execute({
        file: destinationPath,
        passphrase: PASSPHRASE,
        confirmed: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BACKUP/INTEGRITY');
        expect(result.error.messageKey).toBe('errors.BACKUP_INTEGRITY');
      }
      expect(countRows(db)).toBe(1);
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — откат-страховка (AC-5, §19: сбой расшифровки после закрытия)', () => {
  it('мок readContainer после plan → текущая БД возвращена и работоспособна, relaunch запланирован', async () => {
    const { db, file: dbFile } = openFreshDb('rollback.sqlite');
    try {
      insertMeasurements(db, 3);
      const backupPath = await createBackupFile(db, PASSPHRASE, 'rollback.hlbackup');

      // Мок-сбой расшифровки: после успешного plan (первый readContainer) порт
      // «ломается» для файла копии; контейнер страховки (другой путь) — реальный.
      const codec = newCodec();
      let armed = false;
      const failingCrypto: BackupCrypto = {
        prepareKey: (source) => codec.prepareKey(source),
        contentKeyFor: (kdf, source) => codec.contentKeyFor(kdf, source),
        writeContainer: (input) => codec.writeContainer(input),
        readHeader: (input) => codec.readHeader(input),
        readContainer: async (input) => {
          if (armed && input.containerPath === backupPath) {
            throw new BackupIntegrityError('мок: сбой расшифровки после закрытия БД (§19)');
          }
          return codec.readContainer(input);
        },
      };

      const harness = buildRestoreHarness(db, dbFile, { crypto: failingCrypto });
      const planResult = await harness.useCase.execute({
        file: backupPath,
        passphrase: PASSPHRASE,
        confirmed: false,
      });
      expect(planResult.ok).toBe(true);

      armed = true; // ломаем расшифровку ТОЛЬКО execute-фазы (после закрытия БД)
      const execResult = await harness.useCase.execute({
        file: backupPath,
        passphrase: PASSPHRASE,
        confirmed: true,
      });
      expect(execResult.ok).toBe(false);
      if (!execResult.ok) {
        // GCM-неудача неотличима от неверного пароля (крипто) — маппинг по §5.
        expect(execResult.error).toBeInstanceOf(AppError);
        expect(execResult.error.code).toBe('BACKUP/WRONG_PASSPHRASE');
      }

      // AC-5: текущая БД возвращена из страховки и РАБОТОСПОСОБНА (открывается,
      // записи на месте, quick_check ok при открытии).
      const restored = openEncrypted(dbFile, KEY_HEX);
      try {
        expect(countRows(restored)).toBe(3);
      } finally {
        restored.close();
      }
      // Соединение закрыто — приложению нужен перезапуск (решение: relaunch и на
      // неудаче — приложение стартует на возвращённых данных, §9).
      expect(harness.relaunch).toHaveBeenCalledTimes(1);
      // Страховка остаётся в tmp до успешного старта (флаг-файл, §14).
      expect(existsSync(harness.safetyFlagPath)).toBe(true);
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — execute без plan-фазы (AC-6)', () => {
  it('execute самодостаточен: валидный файл без предварительного plan → restarting', async () => {
    const { db, file: dbFile } = openFreshDb('no-plan.sqlite');
    try {
      insertMeasurements(db, 2);
      const backupPath = await createBackupFile(db, PASSPHRASE, 'no-plan.hlbackup');
      const harness = buildRestoreHarness(db, dbFile);

      const result = await harness.useCase.execute({
        file: backupPath,
        passphrase: PASSPHRASE,
        confirmed: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.restarting).toBe(true);
      expect(harness.relaunch).toHaveBeenCalledTimes(1);
      const reopened = openEncrypted(dbFile, KEY_HEX);
      try {
        expect(countRows(reopened)).toBe(2);
      } finally {
        reopened.close();
      }
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });

  it('confirmed без валидного файла → отказ, текущая БД не тронута, relaunch не планировался', async () => {
    const { db, file: dbFile } = openFreshDb('no-file.sqlite');
    try {
      insertMeasurements(db, 1);
      const harness = buildRestoreHarness(db, dbFile);

      const result = await harness.useCase.execute({
        file: join(newDir('hl-restore-missing-'), 'нет-такого.hlbackup'),
        passphrase: PASSPHRASE,
        confirmed: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AppError);
      }
      expect(countRows(db)).toBe(1);
      expect(existsSync(harness.safetyFlagPath)).toBe(false);
      expect(harness.relaunch).not.toHaveBeenCalled();
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('RestoreBackupUseCase — валидация команды (§13, прецедент 070)', () => {
  it('пустой/из пробелов пароль → VALIDATION/FAILED в обеих фазах', async () => {
    const { db, file: dbFile } = openFreshDb('empty-pass.sqlite');
    try {
      insertMeasurements(db, 1);
      const backupPath = await createBackupFile(db, PASSPHRASE, 'empty-pass.hlbackup');
      const harness = buildRestoreHarness(db, dbFile);

      for (const confirmed of [false, true]) {
        const result = await harness.useCase.execute({
          file: backupPath,
          passphrase: '   ',
          confirmed,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION/FAILED');
        }
      }
      expect(countRows(db)).toBe(1);
      expect(harness.relaunch).not.toHaveBeenCalled();
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('cleanupRestoreSafetyCopy (§14: удаление страховки при успешном старте)', () => {
  it('после успешного restore: флаг → каталог страховки удалён, флаг удалён; повтор — no-op', async () => {
    const { db, file: dbFile } = openFreshDb('cleanup.sqlite');
    try {
      insertMeasurements(db, 1);
      const backupPath = await createBackupFile(db, PASSPHRASE, 'cleanup.hlbackup');
      const harness = buildRestoreHarness(db, dbFile);
      const exec = await harness.useCase.execute({
        file: backupPath,
        passphrase: PASSPHRASE,
        confirmed: true,
      });
      expect(exec.ok).toBe(true);

      const flag = JSON.parse(readFileSync(harness.safetyFlagPath, 'utf8')) as { dir: string };
      expect(existsSync(flag.dir)).toBe(true);

      expect(cleanupRestoreSafetyCopy(harness.safetyFlagPath)).toBe(true);
      expect(existsSync(flag.dir)).toBe(false);
      expect(existsSync(harness.safetyFlagPath)).toBe(false);

      // Повторный вызов (флага нет) — false, без исключения (идемпотентный старт).
      expect(cleanupRestoreSafetyCopy(harness.safetyFlagPath)).toBe(false);
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});
