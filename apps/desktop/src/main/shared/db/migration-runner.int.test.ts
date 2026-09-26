/**
 * TASK-024 §19: интеграционные тесты migration runner (tmp-каталог, реальный
 * SQLCipher-стек openEncrypted — порядок старта §9: openEncrypted → runner.migrate()).
 *
 * Матрица (§19/§20):
 *  1. свежая БД → 2 тестовые миграции → schema_version=2, объекты созданы; в meta
 *     только schema_version (data_version инициирует TASK-025, runner не трогает — §8);
 *  2. повторный запуск при актуальной версии — no-op: hook не вызывается (§13);
 *  3. сбой посреди DDL → rollback: схема осталась на предыдущей версии, объекты
 *     предыдущих миграций целы, таблица сбойной миграции отсутствует (§20),
 *     hook-спай вызван ДО DDL (порядок — §19 п. 3, §13);
 *  4. schema_version БД больше известной → AppError STORAGE/DB_NEWER_THAN_APP (§5/EC-25),
 *     hook не вызывается;
 *  + реестр в произвольном порядке → применение строго по возрастанию версий;
 *  + дубликат версии в реестре → TypeError (dev-контракт, прецедент §20 TASK-022).
 *
 * Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '@hl/kernel';

import { MigrationRunner, type Migration } from './migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from './sqlite.js';

/** Случайный ключ БД: 32 байта = 64 hex-символа (§7 TASK-022). */
const randomKeyHex = (): string => randomBytes(32).toString('hex');

/** Текущая версия схемы из meta (один SELECT, §15). */
const readSchemaVersion = (db: EncryptedDatabase): string =>
  (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
    .value;

/** Имена объектов схемы (проверка «объекты созданы/отсутствуют», §19/§20). */
const schemaObjectNames = (db: EncryptedDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

/** Две тестовые миграции (§19 п. 1): каждая создаёт свою таблицу. */
const twoMigrations = (trace: string[]): Migration[] => [
  {
    version: 1,
    up: (db) => {
      trace.push('ddl:1');
      db.exec('CREATE TABLE v1_table (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
    },
  },
  {
    version: 2,
    up: (db) => {
      trace.push('ddl:2');
      db.exec(
        'CREATE TABLE v2_table (id INTEGER PRIMARY KEY, note TEXT NOT NULL);'
          + "INSERT INTO v2_table (note) VALUES ('from-v2');",
      );
    },
  },
];

describe('MigrationRunner (TASK-024 §19/§20)', () => {
  /** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Свежий tmp-каталог на тест (изоляция сценариев друг от друга). */
  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-migration-int-'));
    dirs.push(dir);
    return dir;
  };

  /** Открытая через openEncrypted свежая БД (порядок старта §9). */
  const openFresh = (name: string): { db: EncryptedDatabase; file: string; key: string } => {
    const file = join(newDir(), name);
    const key = randomKeyHex();
    return { db: openEncrypted(file, key), file, key };
  };

  it('(1) свежая БД → 2 миграции: schema_version=2, объекты созданы, hook перед каждой (§19)', async () => {
    const { db } = openFresh('fresh.sqlite');
    const trace: string[] = [];
    const calls: number[] = [];
    const runner = new MigrationRunner({
      migrations: twoMigrations(trace),
      beforeMigration: async (version) => {
        calls.push(version);
        trace.push(`hook:${version}`);
      },
    });

    await runner.migrate(db);

    expect(readSchemaVersion(db)).toBe('2');
    expect(schemaObjectNames(db)).toEqual(
      expect.arrayContaining(['meta', 'v1_table', 'v2_table']),
    );
    // §8: runner не трогает data_version — на свежей БД ключ ровно один.
    expect(
      (db.prepare('SELECT key FROM meta ORDER BY key').all() as { key: string }[]).map(
        (row) => row.key,
      ),
    ).toEqual(['schema_version']);
    // §13/§19: hook — ровно один раз перед каждой применяемой миграцией, до её DDL.
    expect(calls).toEqual([1, 2]);
    expect(trace).toEqual(['hook:1', 'ddl:1', 'hook:2', 'ddl:2']);
    db.close();
  });

  it('(2) повторный запуск при актуальной версии — no-op: hook не вызывается (§13)', async () => {
    const { db } = openFresh('noop.sqlite');
    const trace: string[] = [];
    await new MigrationRunner({
      migrations: twoMigrations(trace),
      beforeMigration: async (version) => {
        trace.push(`hook:${version}`);
      },
    }).migrate(db);

    // Второй прогон — дефолтный no-op hook (§5): интерфейс работает без hook'а.
    const calls: number[] = [];
    await new MigrationRunner({
      migrations: twoMigrations(trace),
      beforeMigration: async (version) => {
        calls.push(version);
      },
    }).migrate(db);

    expect(readSchemaVersion(db)).toBe('2');
    expect(calls).toEqual([]);
    expect(trace).toEqual(['hook:1', 'ddl:1', 'hook:2', 'ddl:2']);
    db.close();
  });

  it('(3) сбой посреди DDL → rollback: версия не изменилась, объекты целы, hook до DDL (§19/§20)', async () => {
    const { db } = openFresh('failure.sqlite');
    // Шаг 1: применяем только v1 — «предыдущие объекты»; схема остаётся на версии 1.
    await new MigrationRunner({ migrations: twoMigrations([]).slice(0, 1) }).migrate(db);
    db.prepare("INSERT INTO v1_table (title) VALUES ('kept')").run();
    expect(readSchemaVersion(db)).toBe('1');

    // Шаг 2: миграция v2 падает в середине DDL-пакета (второй statement — синтаксическая
    // ошибка). DDL в SQLite транзакционен (§13) — v2_left не должна остаться.
    const trace: string[] = [];
    const calls: number[] = [];
    const broken: Migration = {
      version: 2,
      up: (database) => {
        trace.push('ddl:2');
        database.exec(
          'CREATE TABLE v2_left (id INTEGER PRIMARY KEY);'
            + 'CREATE TABLE broken syntax error here;',
        );
      },
    };
    let thrown: unknown;
    try {
      await new MigrationRunner({
        migrations: twoMigrations([]).slice(0, 1).concat(broken),
        beforeMigration: async (version) => {
          calls.push(version);
          trace.push(`hook:${version}`);
        },
      }).migrate(db);
    } catch (error) {
      thrown = error;
    }

    // Наружу — AppError STORAGE/MIGRATION_FAILED с номером версии (§5/§20), не сырая.
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('STORAGE/MIGRATION_FAILED');
    expect((thrown as AppError).params).toEqual({ version: 2 });
    expect((thrown as AppError).cause).toBeInstanceOf(Error);
    // §20: версия не изменилась; предыдущие объекты и данные целы; от сбойной
    // миграции не осталось НИ ОДНОГО объекта (rollback DDL, §13).
    expect(readSchemaVersion(db)).toBe('1');
    expect(schemaObjectNames(db)).toEqual(expect.arrayContaining(['meta', 'v1_table']));
    expect(schemaObjectNames(db)).toEqual(expect.not.arrayContaining(['v2_left']));
    expect(
      db.prepare('SELECT count(*) AS n FROM v1_table').get() as { n: number },
    ).toEqual({ n: 1 });
    // §19 п. 3 (порядок!): hook-спай — до первого DDL сбойной миграции, один раз.
    expect(calls).toEqual([2]);
    expect(trace).toEqual(['hook:2', 'ddl:2']);
    db.close();
  });

  it('(4) schema_version БД больше известной → STORAGE/DB_NEWER_THAN_APP, hook не зовётся (§5)', async () => {
    const { db } = openFresh('newer.sqlite');
    await new MigrationRunner({ migrations: twoMigrations([]) }).migrate(db);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();

    const calls: number[] = [];
    let thrown: unknown;
    try {
      await new MigrationRunner({
        migrations: twoMigrations([]),
        beforeMigration: async (version) => {
          calls.push(version);
        },
      }).migrate(db);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('STORAGE/DB_NEWER_THAN_APP');
    expect((thrown as AppError).params).toEqual({ version: 99 });
    expect(calls).toEqual([]);
    // §5 (EC-25): БД не тронута — версия осталась «из будущего».
    expect(readSchemaVersion(db)).toBe('99');
    db.close();
  });

  it('реестр в произвольном порядке → применение строго по возрастанию версий (§5)', async () => {
    const { db } = openFresh('unordered.sqlite');
    const trace: string[] = [];
    const [m1, m2] = twoMigrations(trace);

    await new MigrationRunner({ migrations: [m2, m1] }).migrate(db);

    expect(readSchemaVersion(db)).toBe('2');
    expect(trace).toEqual(['ddl:1', 'ddl:2']);
    db.close();
  });

  it('дубликат версии в реестре → TypeError в точке вызова (dev-контракт, §7)', () => {
    const duplicated: Migration[] = [
      { version: 1, up: () => undefined },
      { version: 1, up: () => undefined },
    ];
    expect(() => new MigrationRunner({ migrations: duplicated })).toThrow(TypeError);
  });
});
