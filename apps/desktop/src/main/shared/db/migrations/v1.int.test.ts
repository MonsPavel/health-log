/**
 * TASK-025 §19/§20: интеграционные тесты миграции v1 (tmp-каталог, реальный
 * SQLCipher-стек: openEncrypted → MigrationRunner.migrate с РЕАЛЬНЫМ реестром
 * MIGRATIONS — тот же путь, что у приложения на старте, TASK-027).
 *
 * Матрица (§19):
 *  1. применение к свежей БД: таблицы profile и bp_measurement существуют (sqlite_master);
 *  2. seeded-профиль читается (ровно один: id 'seed-profile-0001', имя «Основной», §8);
 *  3. вставка sys=999 → CHECK-ошибка (валидная строка с теми же колонками проходит);
 *  4. вставка без profile_id → ошибка ограничения; с несуществующим profile_id →
 *     FK-ошибка (foreign_keys=ON — openEncrypted, TASK-022 §8);
 *  5. индекс idx_bp_profile_time существует;
 *  6. meta: data_version = '1' (и schema_version = '1' — runner).
 * Дополнительно (§20):
 *  - DDL поимённо совпадает с арх. 04 §3: колонки обеих таблиц — по порядку;
 *  - повторное применение v1 невозможно — runner-защита: второй migrate() — no-op,
 *    seed не задвоен (тест через runner).
 *
 * Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index.js';
import { MigrationRunner } from '../migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../sqlite.js';

/** Строки meta (key → value) — проверки schema_version/data_version (§19 п. 6). */
const readMetaRows = (db: EncryptedDatabase): { key: string; value: string }[] =>
  db.prepare('SELECT key, value FROM meta ORDER BY key').all() as { key: string; value: string }[];

/** Имена таблиц в схеме (sqlite_master, §19 п. 1). */
const tableNames = (db: EncryptedDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

/** Имена индексов в схеме (sqlite_master, §19 п. 5). */
const indexNames = (db: EncryptedDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

/** Имена колонок таблицы по порядку объявления (PRAGMA table_info, сверка §20 с арх. 04 §3). */
const columnNames = (db: EncryptedDatabase, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

/** Число измерений в bp_measurement (санити вставок). */
const measurementCount = (db: EncryptedDatabase): number =>
  (db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as { n: number }).n;

/** Выполняет fn и возвращает пойманную ошибку; без throw — тест падает с пояснением. */
const captureError = (fn: () => void): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('ожидался throw от ограничения БД — вставка неожиданно прошла');
};

/** Код ошибки SQLite на SqliteError (better-sqlite3), например SQLITE_CONSTRAINT_CHECK. */
const errorCode = (error: unknown): string | undefined => (error as { code?: string }).code;

/** Валидная строка измерения (все колонки, §8); переопределения — для проверок CHECK/FK. */
const insertMeasurement = (
  db: EncryptedDatabase,
  overrides: Record<string, unknown> = {},
): void => {
  db.prepare(
    'INSERT INTO bp_measurement ' +
      '(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) ' +
      'VALUES (@id, @profile_id, @taken_at_utc, @tz_offset_minutes, @sys, @dia, @pulse, @irregular_pulse, @arm, @note, @source, @created_at_utc, @updated_at_utc)',
  ).run({
    id: 'm-1',
    profile_id: 'seed-profile-0001',
    taken_at_utc: 1_700_000_000_000,
    tz_offset_minutes: 180,
    sys: 120,
    dia: 80,
    pulse: 60,
    irregular_pulse: 0,
    arm: 'left',
    note: null,
    source: 'manual',
    created_at_utc: 1_700_000_000_000,
    updated_at_utc: 1_700_000_000_000,
    ...overrides,
  });
};

describe('миграция v1 — начальная схема (TASK-025 §19/§20)', () => {
  /** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Свежая БД, приведённая к v1 реальным реестром MIGRATIONS (путь приложения §19). */
  const migrateFresh = async (name: string): Promise<EncryptedDatabase> => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v1-int-'));
    dirs.push(dir);
    const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
    return db;
  };

  it('(1) свежая БД → таблицы profile и bp_measurement существуют (§19 п. 1)', async () => {
    const db = await migrateFresh('fresh.sqlite');

    expect(tableNames(db)).toEqual(expect.arrayContaining(['meta', 'profile', 'bp_measurement']));
    db.close();
  });

  it('(2) seeded-профиль читается: ровно один, id и имя по §8 (§19 п. 2)', async () => {
    const db = await migrateFresh('seed.sqlite');

    const profiles = db.prepare('SELECT id, name, created_at_utc FROM profile').all() as {
      id: string;
      name: string;
      created_at_utc: number;
    }[];
    expect(profiles).toHaveLength(1);
    const seeded = profiles[0];
    expect(seeded?.id).toBe('seed-profile-0001');
    expect(seeded?.name).toBe('Основной');
    // created_at_utc — константа времени запуска миграции (§8): конечное число.
    expect(Number.isFinite(seeded?.created_at_utc)).toBe(true);
    db.close();
  });

  it('(3) вставка sys=999 → CHECK-ошибка; валидная строка проходит (§19 п. 3)', async () => {
    const db = await migrateFresh('check-sys.sqlite');

    // Санити: те же колонки с доменными значениями вставляются — CHECK не мешает домену.
    insertMeasurement(db);
    expect(measurementCount(db)).toBe(1);

    const error = captureError(() => insertMeasurement(db, { id: 'm-bad', sys: 999 }));
    expect(errorCode(error)).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(measurementCount(db)).toBe(1);
    db.close();
  });

  it('(4) ссылка на профиль страхуется БД: без profile_id → NOT NULL, чужой id → FK (§19 п. 4)', async () => {
    const db = await migrateFresh('fk.sqlite');

    // Буквально «без profile_id» раньше срабатывает NOT NULL (колонка NOT NULL, §8):
    // домен всегда передаёт профиль — БД страхует оба способа нарушить ссылку (§13).
    const notNull = captureError(() =>
      db
        .prepare(
          'INSERT INTO bp_measurement ' +
            '(id, taken_at_utc, tz_offset_minutes, sys, dia, arm, created_at_utc, updated_at_utc) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('m-1', 1_700_000_000_000, 180, 120, 80, 'left', 1_700_000_000_000, 1_700_000_000_000),
    );
    expect(errorCode(notNull)).toBe('SQLITE_CONSTRAINT_NOTNULL');

    // FK-ошибка: profile_id указан, но не ссылается на существующий профиль
    // (foreign_keys=ON — TASK-022 §8).
    const foreignKey = captureError(() =>
      insertMeasurement(db, { id: 'm-2', profile_id: 'missing-profile' }),
    );
    expect(errorCode(foreignKey)).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(measurementCount(db)).toBe(0);
    db.close();
  });

  it('(5) индекс idx_bp_profile_time существует (§19 п. 5, §15)', async () => {
    const db = await migrateFresh('index.sqlite');

    expect(indexNames(db)).toContain('idx_bp_profile_time');
    db.close();
  });

  it('(6) meta: data_version = "1" (и schema_version = "1" — runner) (§19 п. 6)', async () => {
    const db = await migrateFresh('meta.sqlite');

    expect(readMetaRows(db)).toEqual([
      { key: 'data_version', value: '1' },
      { key: 'schema_version', value: '1' },
    ]);
    db.close();
  });

  it('DDL поимённо совпадает с арх. 04 §3: колонки обеих таблиц по порядку (§20)', async () => {
    const db = await migrateFresh('ddl-names.sqlite');

    expect(columnNames(db, 'profile')).toEqual(['id', 'name', 'created_at_utc']);
    expect(columnNames(db, 'bp_measurement')).toEqual([
      'id',
      'profile_id',
      'taken_at_utc',
      'tz_offset_minutes',
      'sys',
      'dia',
      'pulse',
      'irregular_pulse',
      'arm',
      'note',
      'source',
      'created_at_utc',
      'updated_at_utc',
    ]);
    db.close();
  });

  it('повторное применение v1 невозможно: runner не даёт, seed не задвоен (§20)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v1-int-'));
    dirs.push(dir);
    const db = openEncrypted(join(dir, 'reapply.sqlite'), randomBytes(32).toString('hex'));
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    // Второй запуск того же реестра: runner обязан пропустить v1 (schema_version=1).
    // Если бы миграция переигралась — CREATE TABLE дал бы «table already exists»,
    // а повторный INSERT в meta — нарушение PK; оба сценария = падение теста.
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    expect(readMetaRows(db)).toEqual([
      { key: 'data_version', value: '1' },
      { key: 'schema_version', value: '1' },
    ]);
    expect((db.prepare('SELECT count(*) AS n FROM profile').get() as { n: number }).n).toBe(1);
    db.close();
  });
});
