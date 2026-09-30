// TASK-075 §19/§20: интеграционные тесты миграции v5 network_event — журнал сети
// EgressGateway (tmp-каталог, реальный SQLCipher-стек: openEncrypted → MigrationRunner
// с РЕАЛЬНЫМ реестром MIGRATIONS — тот же путь, что у приложения; прецеденты
// v1/v2/v3/v4 TASK-025/045/047/051).
//
// Матрица (§19):
//  1. v5 создаёт таблицу network_event (sqlite_master — AC5); DDL поимённо (§5/§8,
//     сверка с арх. 04 §3): id TEXT PK, kind, endpoint, status NOT NULL, bytes
//     INTEGER NULL, at_utc NOT NULL + индекс network_event_kind_at_idx (kind, at_utc)
//     — §8: единственный профиль доступа «выборка по kind в порядке времени»
//     (ротация 90 дней — TASK-103, не здесь); schema_version = 5;
//  2. вставка/чтение строки работают; bytes допускает NULL (blocked/без
//     content-length) и INTEGER (§13: «журнал обновлён байтами» — AC2);
//  3. выборка по (kind, окно времени) идёт по индексу — smoke «последние N по kind»
//     (профиль listRecent TASK-075, §5);
//  4. повторное применение полного реестра — no-op (идемпотентность runner'а, §20
//     AC5): содержимое таблиц цело;
//  5. апгрейд существующего v1-файла (с данными) реестром MIGRATIONS: измерения
//     целы, network_event пуста;
//  6. реестр MIGRATIONS содержит версии [1, 2, 3, 4, 5]; V5_NETWORK_EVENT.version
//     === 5 (§4/§5: нумерация — лиджер обновлён: v5 network_event, v6 ai_summary и
//     v7 chat — будущие задачи P5, имён не занимают).
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { V5_NETWORK_EVENT } from './v5-network-event.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'hl-v5-network-event-int-'));
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

describe('миграция v5 — network_event (TASK-075 §19/§20)', () => {
  it('(1) v5 создаёт таблицу network_event и индекс (kind, at_utc); DDL поимённо; schema_version=5 (AC5)', async () => {
    const db = await migrateFresh('v5-schema.sqlite');

    expect(tableExists(db, 'network_event')).toBe(true);

    const columns = tableColumns(db, 'network_event');
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'kind',
      'endpoint',
      'status',
      'bytes',
      'at_utc',
    ]);
    expect(columns.map((c) => c.type)).toEqual([
      'TEXT',
      'TEXT',
      'TEXT',
      'TEXT',
      'INTEGER',
      'INTEGER',
    ]);
    expect(columns.map((c) => c.notnull)).toEqual([0, 1, 1, 1, 0, 1]); // PK неявно NOT NULL
    expect(columns.map((c) => c.pk)).toEqual([1, 0, 0, 0, 0, 0]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'network_event' " +
          "AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(['network_event_kind_at_idx']);
    const indexInfo = db.prepare('PRAGMA index_info(network_event_kind_at_idx)').all() as {
      name: string;
    }[];
    expect(indexInfo.map((c) => c.name)).toEqual(['kind', 'at_utc']);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    // TASK-087: реестр MIGRATIONS вырос до v6 — на свежей БД версия = максимум
    // реестра (конвенция теста v3 §19 п. 1); v5 применена (таблица выше).
    expect(version.value).toBe(String(MIGRATIONS.at(-1)?.version));
    db.close();
  });

  it('(2) вставка/чтение строки; bytes допускает NULL (blocked) и INTEGER (ок, §13/AC2)', async () => {
    const db = await migrateFresh('v5-rows.sqlite');
    const insert = db.prepare(
      'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run(
      'e-blocked',
      'updates.check',
      'https://releases.example.com/v1',
      'blocked',
      null,
      1000,
    );
    insert.run('e-ok', 'models.download', 'https://cdn.example.com/llm.bin', 'ok', 2048, 2000);

    const blocked = db
      .prepare('SELECT id, kind, endpoint, status, bytes, at_utc FROM network_event WHERE id = ?')
      .get('e-blocked') as {
      id: string;
      kind: string;
      endpoint: string;
      status: string;
      bytes: number | null;
      at_utc: number;
    };
    expect(blocked).toEqual({
      id: 'e-blocked',
      kind: 'updates.check',
      endpoint: 'https://releases.example.com/v1',
      status: 'blocked',
      bytes: null,
      at_utc: 1000,
    });

    const ok = db.prepare('SELECT bytes FROM network_event WHERE id = ?').get('e-ok') as {
      bytes: number;
    };
    expect(ok.bytes).toBe(2048);
    db.close();
  });

  it('(3) профиль «последние N по kind» (listRecent TASK-075): порядок at_utc DESC + LIMIT', async () => {
    const db = await migrateFresh('v5-recent.sqlite');
    const insert = db.prepare(
      'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('e-1', 'updates.check', 'https://releases.example.com/1', 'ok', 10, 1000);
    insert.run('e-2', 'models.download', 'https://cdn.example.com/2', 'ok', 20, 2000);
    insert.run('e-3', 'updates.check', 'https://releases.example.com/3', 'failed', null, 3000);

    const recent = db
      .prepare('SELECT id FROM network_event WHERE kind = ? ORDER BY at_utc DESC, id DESC LIMIT ?')
      .all('updates.check', 1) as { id: string }[];
    expect(recent.map((r) => r.id)).toEqual(['e-3']);
    db.close();
  });

  it('(4) повторное применение полного реестра — no-op: содержимое цело, версия прежняя (идемпотентность runner', async () => {
    const db = await migrateFresh('v5-reapply.sqlite');
    db.prepare(
      'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('e-1', 'updates.check', 'https://releases.example.com/v1', 'blocked', null, 1000);

    await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);

    const events = db.prepare('SELECT count(*) AS n FROM network_event').get() as { n: number };
    expect(events.n).toBe(1);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    // TASK-087: реестр вырос до v6 — версия = максимум реестра, no-op повторного
    // применения её не меняет (конвенция теста v3 §19 п. 5).
    expect(version.value).toBe(String(MIGRATIONS.at(-1)?.version));
    db.close();
  });

  it('(5) апгрейд v1-файла с данными реестром MIGRATIONS: измерения целы, network_event пуста', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v5-network-event-int-'));
    dirs.push(dir);
    const path = join(dir, 'upgrade.sqlite');
    const keyHex = randomBytes(32).toString('hex');

    // Шаг 1 — схема v1 + измерение (жизнь до v5).
    const dbV1 = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: [V1_INITIAL_SCHEMA] }).migrate(dbV1);
    dbV1
      .prepare(
        'INSERT INTO bp_measurement ' +
          "(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) VALUES ('m-1', 'seed-profile-0001', 1, 180, 120, 80, 60, 0, 'left', NULL, 'manual', 1, 1)",
      )
      .run();
    dbV1.close();

    // Шаг 2 — открытие ТЕМ ЖЕ файлом полным реестром: v2 (FTS) + v3 + v4 + v5.
    const db = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    const measurements = db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as {
      n: number;
    };
    expect(measurements.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM network_event').get()).toEqual({ n: 0 });
    db.close();
  });

  it('(6) реестр MIGRATIONS — версии [1, 2, 3, 4, 5, 6] (TASK-087: +v6); V5_NETWORK_EVENT.version === 5 (§4/§5)', () => {
    expect(V5_NETWORK_EVENT.version).toBe(5);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
