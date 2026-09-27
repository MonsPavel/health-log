// TASK-047 §19/§20: интеграционные тесты миграции v3 app_setting (tmp-каталог,
// реальный SQLCipher-стек: openEncrypted → MigrationRunner с РЕАЛЬНЫМ реестром
// MIGRATIONS — тот же путь, что у приложения, прецеденты v1/v2 TASK-025/045).
//
// Матрица (§19):
//  1. v3 создаёт таблицу app_setting; DDL поимённо (§5/§8): key TEXT PK,
//     value_json TEXT NOT NULL, updated_at_utc INTEGER NOT NULL; schema_version = 3;
//  2. вставка и чтение строки работают (значение — JSON-текст); дубль ключа →
//     ограничение PK (хранилище по ключу, §5);
//  3. повторное применение полного реестра — no-op (§20 AC1): runner не вызывает
//     миграцию второй раз, содержимое таблицы цело;
//  4. апгрейд существующего v1-файла (с данными) реестром MIGRATIONS: данные целы,
//     app_setting пуста и готова к записи (seed §8 — пусто, дефолты в коде сервиса);
//  5. реестр MIGRATIONS содержит версии [1, 2, 3]; V3_APP_SETTING.version === 3.
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { V3_APP_SETTING } from './v3-app-setting.js';
import { MIGRATIONS } from './index.js';
import { MigrationRunner, type Migration } from '../migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../sqlite.js';

/** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Свежая зашифрованная БД с переданным реестром миграций (путь приложения §19). */
const migrateWith = async (
  name: string,
  migrations: readonly Migration[],
): Promise<EncryptedDatabase> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-v3-app-setting-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...migrations] }).migrate(db);
  return db;
};

/** БД на актуальной схеме (полный реестр MIGRATIONS). */
const migrateFresh = (name: string): Promise<EncryptedDatabase> => migrateWith(name, MIGRATIONS);

/** Колонки таблицы с типами и NOT NULL (PRAGMA table_info — сверка DDL §20). */
const tableColumns = (
  db: EncryptedDatabase,
  table: string,
): { name: string; type: string; notnull: number; pk: number }[] =>
  db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];

/** Вставка настройки (форма адаптера SettingsStore, §5). */
const insertSetting = (db: EncryptedDatabase, key: string, valueJson: string): void => {
  db.prepare('INSERT INTO app_setting (key, value_json, updated_at_utc) VALUES (?, ?, ?)').run(
    key,
    valueJson,
    1_700_000_000_000,
  );
};

/** Читает value_json по ключу (или undefined). */
const readSetting = (db: EncryptedDatabase, key: string): string | undefined =>
  (
    db.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as
      { value_json: string } | undefined
  )?.value_json;

describe('миграция v3 — app_setting (TASK-047 §19/§20)', () => {
  it('(1) v3 создаёт app_setting с DDL §5: key PK, value_json NOT NULL, updated_at_utc NOT NULL; schema_version=3', async () => {
    const db = await migrateFresh('app-setting-schema.sqlite');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_setting'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const columns = tableColumns(db, 'app_setting');
    expect(columns.map((c) => c.name)).toEqual(['key', 'value_json', 'updated_at_utc']);
    expect(columns.map((c) => c.type)).toEqual(['TEXT', 'TEXT', 'INTEGER']);
    expect(columns.map((c) => c.notnull)).toEqual([0, 1, 1]); // PK неявно NOT NULL — pk-флаг
    expect(columns.map((c) => c.pk)).toEqual([1, 0, 0]);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('3');
    db.close();
  });

  it('(2) вставка по ключу читается; повторный ключ без UPSERT → SQLITE_CONSTRAINT (PK)', async () => {
    const db = await migrateFresh('app-setting-pk.sqlite');
    insertSetting(db, 'prefs', '{"theme":"dark"}');

    expect(readSetting(db, 'prefs')).toBe('{"theme":"dark"}');

    expect(() => insertSetting(db, 'prefs', '{"theme":"light"}')).toThrowError(
      /UNIQUE|constraint/i,
    );
    db.close();
  });

  it('(3) повторное применение полного реестра — no-op: содержимое app_setting цело (§20 AC1)', async () => {
    const db = await migrateFresh('app-setting-reapply.sqlite');
    insertSetting(db, 'prefs', '{"theme":"dark"}');

    // Второй прогон runner-а на уже мигрировавшей БД: миграции ≤ текущей версии
    // не вызываются (§13 TASK-024) — ни ошибки, ни дублей, ни потери данных.
    await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);

    const rows = db.prepare('SELECT count(*) AS n FROM app_setting').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(readSetting(db, 'prefs')).toBe('{"theme":"dark"}');
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('3');
    db.close();
  });

  it('(4) апгрейд v1-файла с данными реестром MIGRATIONS: измерения целы, app_setting пуста (seed §8 — пусто)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v3-app-setting-int-'));
    dirs.push(dir);
    const path = join(dir, 'upgrade.sqlite');
    const keyHex = randomBytes(32).toString('hex');

    // Шаг 1 — схема v1 + измерение (жизнь до v3).
    const dbV1 = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: [V1_INITIAL_SCHEMA] }).migrate(dbV1);
    dbV1
      .prepare(
        'INSERT INTO bp_measurement ' +
          "(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) VALUES ('m-1', 'seed-profile-0001', 1, 180, 120, 80, 60, 0, 'left', NULL, 'manual', 1, 1)",
      )
      .run();
    dbV1.close();

    // Шаг 2 — открытие ТЕМ ЖЕ файлом полным реестром: v2 (FTS) + v3 (app_setting).
    const db = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    const measurements = db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as {
      n: number;
    };
    expect(measurements.n).toBe(1);
    const settings = db.prepare('SELECT count(*) AS n FROM app_setting').get() as { n: number };
    expect(settings.n).toBe(0);
    db.close();
  });

  it('(5) реестр MIGRATIONS — версии [1, 2, 3]; V3_APP_SETTING.version === 3', () => {
    expect(V3_APP_SETTING.version).toBe(3);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
  });
});
