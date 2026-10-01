// TASK-051 §19/§20: интеграционные тесты миграции v4 reference_scale + app_event
// (tmp-каталог, реальный SQLCipher-стек: openEncrypted → MigrationRunner с РЕАЛЬНЫМ
// реестром MIGRATIONS — тот же путь, что у приложения, прецеденты v1/v2/v3
// TASK-025/045/047).
//
// Матрица (§19):
//  1. v4 создаёт ОБЕ таблицы (sqlite_master — AC1); DDL поимённо (§5/§8):
//     reference_scale (id TEXT PK, code, version, source_label, data_json NOT NULL,
//     activated_at_utc NULL), app_event (id TEXT PK, kind, payload_json,
//     at_utc NOT NULL) + индекс по (kind, at_utc); schema_version = 4;
//  2. reference_scale: вставка и чтение строки работают; дубль (code, version)
//     без замещения → ограничение UNIQUE (§8 — защита от дублей при повторной
//     активации);
//  3. activated_at_utc допускает NULL (неактивированная запись-история возможна)
//     и INTEGER (активация) — сортировка по max activated_at_utc работает (§13:
//     активность = max activated_at_utc на code, правило сервиса);
//  4. app_event: вставка/чтение smoke (§19 — потребитель появится в P6
//     TASK-103); индекс (kind, at_utc) существует;
//  5. повторное применение полного реестра — no-op (§20 AC-аналог v3): содержимое
//     таблиц цело;
//  6. апгрейд существующего v1-файла (с данными) реестром MIGRATIONS: измерения
//     целы, reference_scale/app_event пусты;
//  7. реестр MIGRATIONS содержит версии [1, 2, 3, 4]; V4_SCALES_EVENTS.version === 4
//     (§4: нумерация v4 = reference_scale+app_event, консолидация в одной миграции).
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { V4_SCALES_EVENTS } from './v4-scales-events.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'hl-v4-scales-events-int-'));
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

const tableExists = (db: EncryptedDatabase, name: string): boolean =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    { name: string } | undefined) !== undefined;

describe('миграция v4 — reference_scale + app_event (TASK-051 §19/§20)', () => {
  it('(1) v4 создаёт обе таблицы и индекс app_event(kind, at_utc); DDL поимённо; schema_version=4 (AC1)', async () => {
    const db = await migrateFresh('v4-schema.sqlite');

    expect(tableExists(db, 'reference_scale')).toBe(true);
    expect(tableExists(db, 'app_event')).toBe(true);

    const scaleColumns = tableColumns(db, 'reference_scale');
    expect(scaleColumns.map((c) => c.name)).toEqual([
      'id',
      'code',
      'version',
      'source_label',
      'data_json',
      'activated_at_utc',
    ]);
    expect(scaleColumns.map((c) => c.type)).toEqual([
      'TEXT',
      'TEXT',
      'TEXT',
      'TEXT',
      'TEXT',
      'INTEGER',
    ]);
    expect(scaleColumns.map((c) => c.notnull)).toEqual([0, 1, 1, 1, 1, 0]); // PK неявно NOT NULL
    expect(scaleColumns.map((c) => c.pk)).toEqual([1, 0, 0, 0, 0, 0]);

    const eventColumns = tableColumns(db, 'app_event');
    expect(eventColumns.map((c) => c.name)).toEqual(['id', 'kind', 'payload_json', 'at_utc']);
    expect(eventColumns.map((c) => c.type)).toEqual(['TEXT', 'TEXT', 'TEXT', 'INTEGER']);
    expect(eventColumns.map((c) => c.notnull)).toEqual([0, 1, 1, 1]);
    expect(eventColumns.map((c) => c.pk)).toEqual([1, 0, 0, 0]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'app_event' " +
          "AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(['app_event_kind_at_idx']);
    const indexInfo = db.prepare('PRAGMA index_info(app_event_kind_at_idx)').all() as {
      name: string;
    }[];
    expect(indexInfo.map((c) => c.name)).toEqual(['kind', 'at_utc']);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    // TASK-075: реестр MIGRATIONS вырос до v5 — на свежей БД версия = максимум
    // реестра (конвенция теста v3 §19 п. 1); v4 применена (таблицы выше).
    expect(version.value).toBe(String(MIGRATIONS.at(-1)?.version));
    db.close();
  });

  it('(2) вставка по (code, version) читается; повторная пара без замещения → UNIQUE (§8)', async () => {
    const db = await migrateFresh('v4-scale-unique.sqlite');
    db.prepare(
      'INSERT INTO reference_scale (id, code, version, source_label, data_json, activated_at_utc) ' +
        "VALUES ('s-1', 'bp_office_esc2018', '1.0.0', 'ESC/ESH 2018', '{}', 1000)",
    ).run();

    const row = db
      .prepare(
        'SELECT code, version, source_label, data_json, activated_at_utc FROM reference_scale WHERE id = ?',
      )
      .get('s-1') as {
      code: string;
      version: string;
      source_label: string;
      data_json: string;
      activated_at_utc: number;
    };
    expect(row).toEqual({
      code: 'bp_office_esc2018',
      version: '1.0.0',
      source_label: 'ESC/ESH 2018',
      data_json: '{}',
      activated_at_utc: 1000,
    });

    expect(() =>
      db
        .prepare(
          'INSERT INTO reference_scale (id, code, version, source_label, data_json, activated_at_utc) ' +
            "VALUES ('s-2', 'bp_office_esc2018', '1.0.0', 'ESC/ESH 2018', '{}', 2000)",
        )
        .run(),
    ).toThrowError(/UNIQUE|constraint/i);
    db.close();
  });

  it('(3) activated_at_utc NULL допустим; «активная = max activated_at_utc на code», старые версии — история (§13)', async () => {
    const db = await migrateFresh('v4-scale-activity.sqlite');
    const insert = db.prepare(
      'INSERT INTO reference_scale (id, code, version, source_label, data_json, activated_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('s-old', 'bp_office_esc2018', '1.0.0', 'ESC/ESH 2018', '{}', 1000);
    insert.run('s-new', 'bp_office_esc2018', '1.1.0', 'ESC/ESH 2018', '{}', 2000);
    insert.run('s-future', 'bp_office_esc2018', '1.2.0', 'ESC/ESH 2018', '{}', null);

    const active = db
      .prepare(
        'SELECT id FROM reference_scale WHERE code = ? AND activated_at_utc IS NOT NULL ' +
          'ORDER BY activated_at_utc DESC LIMIT 1',
      )
      .get('bp_office_esc2018') as { id: string };
    expect(active.id).toBe('s-new');

    const history = db
      .prepare('SELECT count(*) AS n FROM reference_scale WHERE code = ?')
      .get('bp_office_esc2018') as { n: number };
    expect(history.n).toBe(3);
    db.close();
  });

  it('(4) app_event: вставка/чтение smoke (потребитель — P6 TASK-103)', async () => {
    const db = await migrateFresh('v4-app-event.sqlite');
    db.prepare(
      "INSERT INTO app_event (id, kind, payload_json, at_utc) VALUES ('e-1', 'measurement_added', '{\"id\":\"m-1\"}', 12345)",
    ).run();

    const row = db
      .prepare('SELECT id, kind, payload_json, at_utc FROM app_event WHERE id = ?')
      .get('e-1') as { id: string; kind: string; payload_json: string; at_utc: number };
    expect(row).toEqual({
      id: 'e-1',
      kind: 'measurement_added',
      payload_json: '{"id":"m-1"}',
      at_utc: 12345,
    });

    const byKind = db
      .prepare('SELECT count(*) AS n FROM app_event WHERE kind = ? AND at_utc >= ?')
      .get('measurement_added', 0) as { n: number };
    expect(byKind.n).toBe(1);
    db.close();
  });

  it('(5) повторное применение полного реестра — no-op: содержимое обеих таблиц цело (§20 AC-аналог)', async () => {
    const db = await migrateFresh('v4-reapply.sqlite');
    db.prepare(
      'INSERT INTO reference_scale (id, code, version, source_label, data_json, activated_at_utc) ' +
        "VALUES ('s-1', 'bp_office_esc2018', '1.0.0', 'ESC/ESH 2018', '{}', 1000)",
    ).run();
    db.prepare(
      "INSERT INTO app_event (id, kind, payload_json, at_utc) VALUES ('e-1', 'measurement_added', '{}', 1)",
    ).run();

    await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);

    const scales = db.prepare('SELECT count(*) AS n FROM reference_scale').get() as { n: number };
    const events = db.prepare('SELECT count(*) AS n FROM app_event').get() as { n: number };
    expect(scales.n).toBe(1);
    expect(events.n).toBe(1);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    // TASK-075: версия = максимум реестра (конвенция теста v3 §19 п. 1) — no-op
    // повторного применения её не меняет.
    expect(version.value).toBe(String(MIGRATIONS.at(-1)?.version));
    db.close();
  });

  it('(6) апгрейд v1-файла с данными реестром MIGRATIONS: измерения целы, v4-таблицы пусты', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v4-scales-events-int-'));
    dirs.push(dir);
    const path = join(dir, 'upgrade.sqlite');
    const keyHex = randomBytes(32).toString('hex');

    // Шаг 1 — схема v1 + измерение (жизнь до v4).
    const dbV1 = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: [V1_INITIAL_SCHEMA] }).migrate(dbV1);
    dbV1
      .prepare(
        'INSERT INTO bp_measurement ' +
          "(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) VALUES ('m-1', 'seed-profile-0001', 1, 180, 120, 80, 60, 0, 'left', NULL, 'manual', 1, 1)",
      )
      .run();
    dbV1.close();

    // Шаг 2 — открытие ТЕМ ЖЕ файлом полным реестром: v2 (FTS) + v3 (app_setting) + v4.
    const db = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    const measurements = db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as {
      n: number;
    };
    expect(measurements.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM reference_scale').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM app_event').get()).toEqual({ n: 0 });
    db.close();
  });

  it('(7) реестр MIGRATIONS — версии [1, 2, 3, 4, 5, 6, 7] (TASK-075: +v5, TASK-087: +v6, TASK-089: +v7); V4_SCALES_EVENTS.version === 4', () => {
    expect(V4_SCALES_EVENTS.version).toBe(4);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
