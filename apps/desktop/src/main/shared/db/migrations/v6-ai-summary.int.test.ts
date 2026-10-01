// TASK-087 §19/§20: интеграционные тесты миграции v6 ai_summary — кэш ИИ-резюме
// (tmp-каталог, реальный SQLCipher-стек: openEncrypted → MigrationRunner с РЕАЛЬНЫМ
// реестром MIGRATIONS — тот же путь, что у приложения; прецедент v5 TASK-075).
//
// Матрица (§19):
//  1. v6 создаёт таблицу ai_summary (sqlite_master — AC5); DDL поимённо (§5/§8,
//     сверка с арх. 04 §3): id TEXT PK, profile_id NOT NULL (+FK profile),
//     kind NOT NULL CHECK ('summary'), period_param NOT NULL (канонический
//     '7d'|'30d'|'90d'|'all'|'custom' — ключ сопоставления latest, ревью TASK-087),
//     period_start_utc/period_end_utc NOT NULL, context_hash/model_id/model_version/
//     content_md NOT NULL, data_version NOT NULL, created_at_utc NOT NULL + служебные
//     несъёмные поля disclaimer_text/period_text (решение §5/§7/§20 п.6 — отдельные
//     поля рендера) + индекс ai_summary_profile_created_idx (profile_id,
//     created_at_utc DESC); schema_version = 6;
//  2. вставка/чтение строки работают; CHECK (kind) отбраковывает чужой kind (§8);
//  3. профиль «latest по периоду» идёт по индексу (profile_id, created_at_utc DESC) —
//     smoke «последняя по периоду» (профиль latestForPeriod TASK-087, §5);
//  4. повторное применение полного реестра — no-op (идемпотентность runner'а, §20);
//  5. апгрейд существующего v1-файла (с данными) реестром MIGRATIONS: измерения
//     целы, ai_summary пуста;
//  6. реестр MIGRATIONS содержит версии [1..6]; V6_AI_SUMMARY.version === 6 (§4/§5).
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { V6_AI_SUMMARY } from './v6-ai-summary.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'hl-v6-ai-summary-int-'));
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

describe('миграция v6 — ai_summary (TASK-087 §19/§20)', () => {
  it('(1) v6 создаёт таблицу ai_summary и индекс (profile_id, created_at_utc desc); DDL поимённо; schema_version=6', async () => {
    const db = await migrateFresh('v6-schema.sqlite');

    expect(tableExists(db, 'ai_summary')).toBe(true);

    const columns = tableColumns(db, 'ai_summary');
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'profile_id',
      'kind',
      'period_param',
      'period_start_utc',
      'period_end_utc',
      'context_hash',
      'model_id',
      'model_version',
      'data_version',
      'content_md',
      'disclaimer_text',
      'period_text',
      'created_at_utc',
    ]);
    expect(columns.map((c) => c.type)).toEqual([
      'TEXT',
      'TEXT',
      'TEXT',
      'TEXT',
      'INTEGER',
      'INTEGER',
      'TEXT',
      'TEXT',
      'TEXT',
      'INTEGER',
      'TEXT',
      'TEXT',
      'TEXT',
      'INTEGER',
    ]);
    // PK неявно NOT NULL (0), период-параметр/служебные поля/created — NOT NULL (1).
    expect(columns.map((c) => c.notnull)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(columns.map((c) => c.pk)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // FK на profile(id) — арх. 04 §3 (внешние ключи SQLite по умолчанию выключены,
    // constraint — декларация схемы; валидация скоупа — порты/use case).
    const fk = db.prepare('PRAGMA foreign_key_list(ai_summary)').all() as {
      table: string;
      from: string;
      to: string;
    }[];
    expect(fk.map(({ table, from, to }) => ({ table, from, to }))).toEqual([
      { table: 'profile', from: 'profile_id', to: 'id' },
    ]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_summary' " +
          "AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(['ai_summary_profile_created_idx']);
    const indexInfo = db.prepare('PRAGMA index_info(ai_summary_profile_created_idx)').all() as {
      name: string;
    }[];
    expect(indexInfo.map((c) => c.name)).toEqual(['profile_id', 'created_at_utc']);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('6');
    db.close();
  });

  it('(2) вставка/чтение строки работают; CHECK (kind) отбраковывает чужой kind (§8)', async () => {
    const db = await migrateFresh('v6-rows.sqlite');
    const insert = db.prepare(
      'INSERT INTO ai_summary (id, profile_id, kind, period_param, period_start_utc, ' +
        'period_end_utc, context_hash, model_id, model_version, data_version, content_md, ' +
        'disclaimer_text, period_text, created_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(
      's-1',
      'seed-profile-0001',
      'summary',
      '30d',
      1000,
      2000,
      'a'.repeat(64),
      'test-model',
      '1.0.0',
      3,
      'Разбор периода',
      'Это не медицинская консультация.',
      'последние 30 дней',
      5000,
    );

    const row = db
      .prepare(
        'SELECT id, profile_id, kind, period_param, period_start_utc, period_end_utc, ' +
          'context_hash, model_id, model_version, data_version, content_md, disclaimer_text, ' +
          'period_text, created_at_utc FROM ai_summary WHERE id = ?',
      )
      .get('s-1') as Record<string, unknown>;
    expect(row).toEqual({
      id: 's-1',
      profile_id: 'seed-profile-0001',
      kind: 'summary',
      period_param: '30d',
      period_start_utc: 1000,
      period_end_utc: 2000,
      context_hash: 'a'.repeat(64),
      model_id: 'test-model',
      model_version: '1.0.0',
      data_version: 3,
      content_md: 'Разбор периода',
      disclaimer_text: 'Это не медицинская консультация.',
      period_text: 'последние 30 дней',
      created_at_utc: 5000,
    });

    // CHECK (kind IN ('summary')) — чужой kind не проходит (§8: DDL арх. 04 §3).
    expect(() =>
      insert.run(
        's-bad',
        'seed-profile-0001',
        'chat',
        '30d',
        1,
        2,
        'b'.repeat(64),
        'm',
        '1',
        1,
        'x',
        'd',
        'p',
        1,
      ),
    ).toThrow();
    db.close();
  });

  it('(3) профиль «latest по периоду»: порядок (profile_id, created_at_utc DESC) — первая строка новейшая', async () => {
    const db = await migrateFresh('v6-latest.sqlite');
    const insert = db.prepare(
      'INSERT INTO ai_summary (id, profile_id, kind, period_param, period_start_utc, ' +
        'period_end_utc, context_hash, model_id, model_version, data_version, content_md, ' +
        'disclaimer_text, period_text, created_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const seedProfile = 'seed-profile-0001';
    insert.run(
      's-old',
      seedProfile,
      'summary',
      '30d',
      1000,
      2000,
      'a'.repeat(64),
      'm',
      '1',
      1,
      'старое',
      'd',
      'p',
      1000,
    );
    insert.run(
      's-new',
      seedProfile,
      'summary',
      '30d',
      1000,
      2000,
      'b'.repeat(64),
      'm',
      '1',
      2,
      'новое',
      'd',
      'p',
      3000,
    );
    insert.run(
      's-other',
      seedProfile,
      'summary',
      'custom',
      9000,
      9500,
      'c'.repeat(64),
      'm',
      '1',
      2,
      'другой период',
      'd',
      'p',
      4000,
    );

    // Профиль latestForPeriod пресета (§5/ревью): по каноническому period_param
    // (границы — метаданные), created_at_utc DESC.
    const latest = db
      .prepare(
        'SELECT id FROM ai_summary WHERE profile_id = ? AND period_param = ? ' +
          'ORDER BY created_at_utc DESC, id DESC LIMIT 1',
      )
      .get(seedProfile, '30d') as { id: string };
    expect(latest.id).toBe('s-new');
    db.close();
  });

  it('(4) повторное применение полного реестра — no-op: содержимое цело, версия прежняя', async () => {
    const db = await migrateFresh('v6-reapply.sqlite');
    db.prepare(
      'INSERT INTO ai_summary (id, profile_id, kind, period_param, period_start_utc, ' +
        'period_end_utc, context_hash, model_id, model_version, data_version, content_md, ' +
        'disclaimer_text, period_text, created_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      's-1',
      'seed-profile-0001',
      'summary',
      'all',
      1,
      2,
      'a'.repeat(64),
      'm',
      '1',
      1,
      'x',
      'd',
      'p',
      1,
    );

    await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);

    const rows = db.prepare('SELECT count(*) AS n FROM ai_summary').get() as { n: number };
    expect(rows.n).toBe(1);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('6');
    db.close();
  });

  it('(5) апгрейд v1-файла с данными реестром MIGRATIONS: измерения целы, ai_summary пуста', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v6-ai-summary-int-'));
    dirs.push(dir);
    const path = join(dir, 'upgrade.sqlite');
    const keyHex = randomBytes(32).toString('hex');

    // Шаг 1 — схема v1 + измерение (жизнь до v6).
    const dbV1 = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: [V1_INITIAL_SCHEMA] }).migrate(dbV1);
    dbV1
      .prepare(
        'INSERT INTO bp_measurement ' +
          "(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) VALUES ('m-1', 'seed-profile-0001', 1, 180, 120, 80, 60, 0, 'left', NULL, 'manual', 1, 1)",
      )
      .run();
    dbV1.close();

    // Шаг 2 — открытие ТЕМ ЖЕ файлом полным реестром: v2…v6.
    const db = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    const measurements = db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as {
      n: number;
    };
    expect(measurements.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM ai_summary').get()).toEqual({ n: 0 });
    db.close();
  });

  it('(6) реестр MIGRATIONS — версии [1, 2, 3, 4, 5, 6]; V6_AI_SUMMARY.version === 6 (§4/§5)', () => {
    expect(V6_AI_SUMMARY.version).toBe(6);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
