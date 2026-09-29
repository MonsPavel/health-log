/**
 * TASK-070 §19/§20: интеграционные тесты use case CreateBackup (tmp-каталоги,
 * реальный SQLCipher-стек openEncrypted + реальный MigrationRunner).
 *
 * Матрица (§20):
 *  1. Roundtrip (AC-1/AC-2): создать копию с паролем (mode ask, fake-FileSaver) →
 *     расшифровать ТЕМ ЖЕ crypto-модулем (contentKeyFor по записи манифеста — путь
 *     восстановления 071) → sha256(payload) == manifest.dbSha256 → payload на файл →
 *     openEncrypted снапшота → записи равны исходной БД;
 *  2. манифест: все поля §2 (formatVersion/schemaVersion/appVersion/createdAtUtc/counts/
 *     dbSha256/kdf), counts — реальный COUNT;
 *  3. mode auto (hook-путь, §5/§9): без диалога, файл в userData/backups под заданным
 *     именем (§7: pre-migration-vN.hlbackup), расшифровка ключом БД;
 *  4. hook миграций TASK-024 (AC-4): реальный runner с hook'ом → pre-migration-v1/v2
 *     появились; сбой копии → STORAGE/MIGRATION_FAILED (порядок hook → DDL, TASK-024);
 *  5. отмена диалога (§13) → BACKUP/CANCELED, файлов нет;
 *  6. пароль-политика (§13): пустой/из пробелов → VALIDATION/FAILED; 1 символ —
 *     ДОПУСТИМ (предупреждение — UI 073, main не блокирует);
 *  7. полный диск (мок-поток записи «ENOSPC») → BACKUP/FAILED, tmp-файлы удалены
 *     (AC-5: каталог копий без *.tmp, tmp-каталоги снапшотов иссякли);
 *  8. прогресс (AC-6): фазы snapshot → encrypt → write доставлены по порядку (spy);
 *  9. FileOpQueue: две параллельные операции не перекрываются;
 *  10. §14: пароль копии не попадает в лог (redact-страховка, ключи манифеста — нет).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { BackupManifest } from '@hl/contracts';
import { AppError, FixedClock } from '@hl/kernel';

import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner, type Migration } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import {
  BackupContainerCodec,
  type BackupContainerCodecOptions,
} from '../adapters/backup-container.js';
import type { BackupCrypto } from './ports/backup-crypto.js';
import type { BackupFileSaver } from './ports/backup-file-saver.js';
import { CreateBackupUseCase, createPreMigrationBackupHook } from './create-backup.js';
import { FileOpQueue } from './file-op-queue.js';

/** Фиксированное «сейчас» FixedClock — конвенция контрактных наборов. */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
/** Тестовый ключ БД (32 байта) — тот же в рамках сценария. */
const KEY_HEX = randomBytes(32).toString('hex');
/** Пароль копии для roundtrip. */
const PASSPHRASE = 'пароль-копии-070';

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

/** Мета-сборщик логгера: все записи (для redact-проверки §14 и факта лога §18). */
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
 * Свежая БД с реестром миграций (schema_version = максимум реестра, сид профиля) —
 * прецедент container.int.test.ts §19. Закрывается вызывающим тестом (Windows).
 */
const openFreshDb = (name: string): { db: EncryptedDatabase; file: string } => {
  const file = join(newDir('hl-backup-db-'), name);
  const db = openEncrypted(file, KEY_HEX);
  return { db, file };
};

/** Мигрирует свежую БД реестром приложения (без hook'а) — рабочая схема v4. */
const migrateFresh = (db: EncryptedDatabase): Promise<void> =>
  new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

/** Вставляет count измерений сид-профилю (сырой SQL, прецедент container.int.test). */
const insertMeasurements = (db: EncryptedDatabase, count: number): void => {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      "INSERT INTO bp_measurement (id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, source, created_at_utc, updated_at_utc) VALUES (?, 'seed-profile-0001', ?, 180, 120, 80, 70, 0, 'left', 'manual', ?, ?)",
    ).run(`m-${i}-${randomBytes(4).toString('hex')}`, NOW_MS + i, NOW_MS, NOW_MS);
  }
};

/** Сборка use case (§19: подстановочные зависимости вокруг реального кодека). */
interface HarnessOptions {
  readonly codec?: BackupCrypto;
  readonly fileSaver?: BackupFileSaver;
  readonly dbKeyHex?: () => string;
  readonly backupsDir?: string;
}
interface Harness {
  readonly backupsDir: string;
  /** Выделенный корень tmp-снапшотов — точка наблюдения чистки (AC-5, без гонок suite). */
  readonly snapshotRoot: string;
  readonly useCase: CreateBackupUseCase;
  readonly entries: LogEntry[];
  readonly fileSaver: BackupFileSaver;
}
const buildHarness = (db: EncryptedDatabase, options: HarnessOptions = {}): Harness => {
  const backupsDir = options.backupsDir ?? newDir('hl-backups-');
  const snapshotRoot = newDir('hl-backup-snap-root-');
  const { entries, logger } = recordingLogger();
  const fileSaver: BackupFileSaver = options.fileSaver ?? {
    save: vi.fn().mockResolvedValue(join(newDir('hl-backup-ask-'), 'picked.hlbackup')),
  };
  const useCase = new CreateBackupUseCase({
    db,
    clock: new FixedClock(NOW_MS, TZ),
    logger,
    crypto: options.codec ?? newCodec(),
    fileSaver,
    queue: new FileOpQueue(),
    backupsDir,
    appVersion: 'test-0.7.0',
    dbKeyHex: options.dbKeyHex ?? (() => KEY_HEX),
    snapshotTmpRoot: snapshotRoot,
  });
  return { backupsDir, snapshotRoot, useCase, entries, fileSaver };
};

/** Читает все измерения снапшота (сравнение roundtrip, AC-1). */
const readRows = (
  db: EncryptedDatabase,
): { id: string; sys: number; dia: number; note: string | null }[] =>
  db.prepare('SELECT id, sys, dia, note FROM bp_measurement ORDER BY taken_at_utc').all() as {
    id: string;
    sys: number;
    dia: number;
    note: string | null;
  }[];

describe('CreateBackupUseCase — roundtrip и манифест (AC-1/AC-2, §19)', () => {
  it('создание с паролем → расшифровка тем же кодеком → openEncrypted снапшота → записи равны', async () => {
    const { db } = openFreshDb('roundtrip.sqlite');
    try {
      await migrateFresh(db);
      insertMeasurements(db, 3);
      const askDir = newDir('hl-backup-ask-');
      const targetPath = join(askDir, 'health-log-backup.hlbackup');
      const { useCase, entries } = buildHarness(db, {
        fileSaver: { save: vi.fn().mockResolvedValue(targetPath) },
      });

      const result = await useCase.execute({ mode: 'ask', passphrase: PASSPHRASE });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Ответ §18: basename, размер, манифест.
      expect(result.value.file).toBe('health-log-backup.hlbackup');
      expect(result.value.path).toBe(targetPath);
      expect(result.value.sizeBytes).toBe(readFileSync(targetPath).length);
      expect(result.value.manifest.formatVersion).toBe(1);

      // Манифест §2 целиком (AC-2).
      const manifest: BackupManifest = result.value.manifest;
      expect(manifest.schemaVersion).toBe(MIGRATIONS.at(-1)?.version);
      expect(manifest.appVersion).toBe('test-0.7.0');
      expect(manifest.createdAtUtc).toBe(NOW_MS);
      expect(manifest.counts).toEqual({ measurements: 3 });
      expect(manifest.dbSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.kdf.id).toBe('argon2id');

      // Расшифровка ТЕМ ЖЕ модулем по записи kdf манифеста (путь восстановления 071).
      const codec = newCodec();
      const contentKey = await codec.contentKeyFor(manifest.kdf, {
        kind: 'passphrase',
        passphrase: PASSPHRASE,
      });
      const read = await codec.readContainer({ containerPath: targetPath, contentKey });
      // sha256 расшифрованного файла совпадает с манифестом (AC-2).
      expect(createHash('sha256').update(read.payload).digest('hex')).toBe(manifest.dbSha256);

      // Снапшот открывается как зашифрованная БД тем же ключом (AC-1: VACUUM INTO
      // сохраняет шифрование), записи равны исходной БД.
      const snapshotPath = join(askDir, 'restored-snapshot.db');
      writeFileSync(snapshotPath, read.payload);
      const snapshot = openEncrypted(snapshotPath, KEY_HEX);
      try {
        expect(readRows(snapshot)).toEqual(readRows(db));
        expect(readRows(snapshot)).toHaveLength(3);
      } finally {
        snapshot.close();
      }

      // §18: лог факта — basename/размер/длительность, без полного пути.
      const created = entries.find((entry) => entry.message === 'backup created');
      expect(created).toBeDefined();
      expect(created?.meta).toMatchObject({
        file: 'health-log-backup.hlbackup',
        sizeBytes: result.value.sizeBytes,
      });
      expect(typeof created?.meta?.['durationMs']).toBe('number');
      expect(JSON.stringify(entries)).not.toContain(askDir);
    } finally {
      db.close();
    }
  });
});

describe('CreateBackupUseCase — mode auto (hook-путь, §5/§7/§9)', () => {
  it('без диалога: файл в backupsDir под заданным именем, расшифровка ключом БД', async () => {
    const { db } = openFreshDb('auto.sqlite');
    try {
      await migrateFresh(db);
      insertMeasurements(db, 2);
      const save = vi.fn();
      const { useCase, backupsDir } = buildHarness(db, { fileSaver: { save } });

      const result = await useCase.execute({
        mode: 'auto',
        targetName: 'pre-migration-v9.hlbackup',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // §7: имя фикс; §5/§9: диалога не было.
      expect(save).not.toHaveBeenCalled();
      expect(result.value.file).toBe('pre-migration-v9.hlbackup');
      const finalPath = join(backupsDir, 'pre-migration-v9.hlbackup');
      expect(existsSync(finalPath)).toBe(true);
      expect(result.value.manifest.kdf).toEqual({ id: 'db-key' });
      expect(result.value.manifest.counts).toEqual({ measurements: 2 });

      // Расшифровка ключом БД (машиносвязная авто-копия, §8).
      const codec = newCodec();
      const contentKey = await codec.contentKeyFor(
        { id: 'db-key' },
        { kind: 'dbKey', keyHex: KEY_HEX },
      );
      const read = await codec.readContainer({ containerPath: finalPath, contentKey });
      expect(createHash('sha256').update(read.payload).digest('hex')).toBe(
        result.value.manifest.dbSha256,
      );

      // Без имени — метка времени от Clock (детерминизм тестов; 1758816000000 →
      // 2025-09-25T16:00:00Z).
      const stamped = await useCase.execute({ mode: 'auto' });
      expect(stamped.ok).toBe(true);
      if (stamped.ok) {
        expect(stamped.value.file).toBe('health-log-backup-20250925T160000.hlbackup');
        expect(existsSync(join(backupsDir, stamped.value.file))).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});

describe('CreateBackupUseCase — hook миграций TASK-024 (AC-4, §19/§22)', () => {
  it('реальный runner: перед каждой миграцией создаётся pre-migration-vN.hlbackup', async () => {
    const { db } = openFreshDb('hook.sqlite');
    try {
      const backupsDir = newDir('hl-backups-');
      const { useCase } = buildHarness(db, { backupsDir });
      // Две тестовые миграции (прецедент migration-runner.int.test.ts §19).
      const migrations: Migration[] = [
        { version: 101, up: (database) => void database.exec('CREATE TABLE t70_1 (id INTEGER)') },
        { version: 102, up: (database) => void database.exec('CREATE TABLE t70_2 (id INTEGER)') },
      ];
      const order: string[] = [];
      await new MigrationRunner({
        migrations,
        beforeMigration: (version) => {
          order.push(`hook:${version}`);
          return createPreMigrationBackupHook(useCase)(version);
        },
      }).migrate(db);

      // Файлы §7 появились (v1 — до DDL первой миграции, v2 — до второй).
      expect(order).toEqual(['hook:101', 'hook:102']);
      expect(existsSync(join(backupsDir, 'pre-migration-v101.hlbackup'))).toBe(true);
      expect(existsSync(join(backupsDir, 'pre-migration-v102.hlbackup'))).toBe(true);

      // Снапшот v1 открывается тем же ключом БД (шифрование сохранено, §14).
      const codec = newCodec();
      const contentKey = await codec.contentKeyFor(
        { id: 'db-key' },
        { kind: 'dbKey', keyHex: KEY_HEX },
      );
      const read = await codec.readContainer({
        containerPath: join(backupsDir, 'pre-migration-v101.hlbackup'),
        contentKey,
      });
      const snapshotPath = join(backupsDir, 'v101-snapshot.db');
      writeFileSync(snapshotPath, read.payload);
      const snapshot = openEncrypted(snapshotPath, KEY_HEX);
      try {
        // Состояние ДО первой миграции: таблиц миграции ещё нет.
        const names = (
          snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name);
        expect(names).toEqual(expect.not.arrayContaining(['t70_1', 't70_2']));
      } finally {
        snapshot.close();
      }
    } finally {
      db.close();
    }
  });

  it('сбой копии в hook → STORAGE/MIGRATION_FAILED до DDL (§22: порядок runner', async () => {
    const { db } = openFreshDb('hook-failure.sqlite');
    try {
      const { useCase } = buildHarness(db, { dbKeyHex: () => 'не-hex' });
      const migrations: Migration[] = [
        {
          version: 201,
          up: (database) => void database.exec('CREATE TABLE t70_fail (id INTEGER)'),
        },
      ];
      let thrown: unknown;
      try {
        await new MigrationRunner({
          migrations,
          beforeMigration: createPreMigrationBackupHook(useCase),
        }).migrate(db);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('STORAGE/MIGRATION_FAILED');
      expect((thrown as AppError).params).toEqual({ version: 201 });
      // DDL не применён (hook до DDL, TASK-024 §13).
      expect(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      ).toEqual(expect.not.arrayContaining(['t70_fail']));
    } finally {
      db.close();
    }
  });
});

describe('CreateBackupUseCase — отмена и пароль-политика (§13)', () => {
  it('отказ диалога сохранения → err BACKUP/CANCELED, файлов нет', async () => {
    const { db } = openFreshDb('cancel.sqlite');
    try {
      await migrateFresh(db);
      const backupsDir = newDir('hl-backups-');
      const { useCase, snapshotRoot } = buildHarness(db, {
        backupsDir,
        fileSaver: { save: vi.fn().mockResolvedValue(null) },
      });

      const result = await useCase.execute({ mode: 'ask', passphrase: PASSPHRASE });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error).toBeInstanceOf(AppError);
      expect(result.error.code).toBe('BACKUP/CANCELED');
      expect(result.error.messageKey).toBe('errors.BACKUP_CANCELED');
      // Отмена — ДО фаз: tmp-снапшот не создавался, целевой каталог пуст (mkdtemp-
      // каталог создаёт сам тест — use case в ask-режиме ничего не пишет, §13).
      expect(readdirSync(snapshotRoot)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('пустой/из пробелов пароль → VALIDATION/FAILED (копия без пароля не создаётся)', async () => {
    const { db } = openFreshDb('policy.sqlite');
    try {
      await migrateFresh(db);
      const { useCase, backupsDir } = buildHarness(db);

      for (const passphrase of ['', '   ']) {
        const result = await useCase.execute({ mode: 'ask', passphrase });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('VALIDATION/FAILED');
        }
      }
      // Целевой каталог пуст: до диалога/снапшота дело не доходит (§13).
      expect(existsSync(backupsDir)).toBe(true);
      expect(readdirSync(backupsDir)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('§13: пароль короче 8 символов НЕ блокируется (предупреждение — UI 073)', async () => {
    const { db } = openFreshDb('short-pass.sqlite');
    try {
      await migrateFresh(db);
      const { useCase } = buildHarness(db);

      const result = await useCase.execute({ mode: 'ask', passphrase: 'x' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Копия с коротким паролем расшифровывается (форма валидна, §13).
        const codec = newCodec();
        const contentKey = await codec.contentKeyFor(result.value.manifest.kdf, {
          kind: 'passphrase',
          passphrase: 'x',
        });
        await expect(
          codec.readContainer({ containerPath: result.value.path, contentKey }),
        ).resolves.toBeDefined();
      }
    } finally {
      db.close();
    }
  });
});

describe('CreateBackupUseCase — полный диск (AC-5, §13/§19: мок записи)', () => {
  it('ENOSPC-мок → err BACKUP/FAILED; tmp-контейнер и каталог снапшота удалены', async () => {
    const { db } = openFreshDb('diskfull.sqlite');
    try {
      await migrateFresh(db);
      const backupsDir = newDir('hl-backups-');
      mkdirSync(backupsDir, { recursive: true });

      // /dev/full-подобный мок: первая порция пишется НАСТОЯЩИМИ байтами в файл
      // (partial-контейнер существует), вторая — ENOSPC; fd не удерживается
      // (writeFile открывает и закрывает) — чистка на Windows детерминирована.
      let tmpContainerPath: string | undefined;
      const failingFactory = (path: string): Writable => {
        tmpContainerPath = path;
        let first = true;
        return new Writable({
          write(chunk: Buffer, _enc, cb) {
            if (first) {
              first = false;
              // Первая порция — НАСТОЯЩИЕ байты в файл (partial-контейнер существует);
              // fd не удерживается (writeFile открывает и закрывает) — чистка на
              // Windows детерминирована.
              void writeFile(path, chunk).then(
                () => cb(),
                (error: Error) => cb(error),
              );
              return;
            }
            cb(new Error('ENOSPC: no space left on device (mock)'));
          },
          final(cb) {
            cb();
          },
        });
      };

      const { useCase, snapshotRoot } = buildHarness(db, {
        backupsDir,
        codec: newCodec({ createWriteStream: failingFactory }),
      });

      const result = await useCase.execute({
        mode: 'auto',
        targetName: 'disk-full.hlbackup',
        onProgress: () => undefined,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.code).toBe('BACKUP/FAILED');
      expect(result.error.messageKey).toBe('errors.BACKUP_FAILED');
      expect(String(result.error.cause)).toContain('ENOSPC');

      // AC-5: tmp-файлы удалены — каталог копий чист, tmp-контейнер с реальными
      // байтами удалён, каталог tmp-снапшотов (открытый текст) пуст, финальный
      // файл не создан.
      expect(existsSync(join(backupsDir, 'disk-full.hlbackup'))).toBe(false);
      expect(tmpContainerPath).toBeDefined();
      expect(existsSync(tmpContainerPath as string)).toBe(false);
      expect(readdirSync(backupsDir)).toEqual([]);
      expect(readdirSync(snapshotRoot)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('CreateBackupUseCase — прогресс (AC-6) и очередь (§9)', () => {
  it('фазы snapshot → encrypt → write доставлены по порядку (spy)', async () => {
    const { db } = openFreshDb('progress.sqlite');
    try {
      await migrateFresh(db);
      const { useCase } = buildHarness(db);

      const phases: string[] = [];
      const result = await useCase.execute({
        mode: 'auto',
        targetName: 'progress.hlbackup',
        onProgress: (phase) => phases.push(phase),
      });
      expect(result.ok).toBe(true);
      expect(phases).toEqual(['snapshot', 'encrypt', 'write']);
    } finally {
      db.close();
    }
  });

  it('FileOpQueue: параллельные execute не перекрываются (сериализация, §9)', async () => {
    const { db } = openFreshDb('queue.sqlite');
    try {
      await migrateFresh(db);
      const codec = newCodec();
      let inside = 0;
      let overlapped = false;
      const watched: BackupCrypto = {
        prepareKey: (source) => codec.prepareKey(source),
        contentKeyFor: (kdf, source) => codec.contentKeyFor(kdf, source),
        writeContainer: async (input) => {
          inside += 1;
          if (inside > 1) {
            overlapped = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          try {
            return await codec.writeContainer(input);
          } finally {
            inside -= 1;
          }
        },
        readContainer: (input) => codec.readContainer(input),
      };
      const { useCase } = buildHarness(db, { codec: watched });

      const [first, second] = await Promise.all([
        useCase.execute({ mode: 'auto', targetName: 'q1.hlbackup' }),
        useCase.execute({ mode: 'auto', targetName: 'q2.hlbackup' }),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(overlapped).toBe(false);
    } finally {
      db.close();
    }
  });

  it('§14: пароль копии не попадает в лог (redact-страховка манифеста)', async () => {
    const { db } = openFreshDb('redact.sqlite');
    try {
      await migrateFresh(db);
      const { useCase, entries } = buildHarness(db);

      const result = await useCase.execute({ mode: 'ask', passphrase: 'секрет-пароль-070' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Ни одна запись лога не содержит пароль или соль KDF (базовые байты секрета).
      const dumped = JSON.stringify(entries);
      expect(dumped).not.toContain('секрет-пароль-070');
      expect(dumped).not.toContain(
        result.value.manifest.kdf.id === 'argon2id' ? result.value.manifest.kdf.saltB64 : '',
      );
      // §18: лог — только факты (имя/размер/длительность).
      expect(entries.some((entry) => entry.message === 'backup created')).toBe(true);
      expect(basename(result.value.path)).toBe(result.value.file);
    } finally {
      db.close();
    }
  });
});
