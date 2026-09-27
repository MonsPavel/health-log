// TASK-045 §19/§20: интеграционные тесты миграции v2 (tmp-каталог, реальный
// SQLCipher-стек: openEncrypted → MigrationRunner с РЕАЛЬНЫМ реестром MIGRATIONS —
// тот же путь, что у приложения, прецедент v1.int.test.ts TASK-025).
//
// Матрица (§19):
//  1. миграция v2 создаёт FTS-таблицу bp_measurement_fts + 3 триггера (sqlite_master);
//  2. backfill индексирует СУЩЕСТВУЮЩИЕ заметки (апгрейд v1→v2: записи до миграции
//     находит поиском после);
//  3. CRUD-синхронизация триггерами:
//     а) вставил (с заметкой) → находит;
//     б) обновил заметку → находит НОВУЮ, старую — нет;
//     в) удалил → не находит;
//  4. честное поведение без морфологии (§20 AC3): «болит голова» НЕ находит
//     «болела голова» (токены точные), но LIKE «болел» находит «болела»;
//  5. rebuild-команда (§8) — repair: идемпотентна, индекс согласован с таблицей;
//  6. schema_version = 2 после апгрейда реестром MIGRATIONS.
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { rebuildFtsIndex, V2_FTS_NOTES } from './v2-fts.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'hl-v2-fts-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...migrations] }).migrate(db);
  return db;
};

/** БД на актуальной схеме (полный реестр MIGRATIONS). */
const migrateFresh = (name: string): Promise<EncryptedDatabase> => migrateWith(name, MIGRATIONS);

/** Валидная вставка измерения (колонки v1, §8); note — по желанию. */
const insertMeasurement = (db: EncryptedDatabase, id: string, note: string | null): void => {
  db.prepare(
    'INSERT INTO bp_measurement ' +
      '(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    'seed-profile-0001',
    1_700_000_000_000,
    180,
    120,
    80,
    60,
    0,
    'left',
    note,
    'manual',
    1_700_000_000_000,
    1_700_000_000_000,
  );
};

/** MATCH-поиск по FTS-индексу: rowid'ы найденных строк bp_measurement. */
const matchRowIds = (db: EncryptedDatabase, matchQuery: string): number[] =>
  (
    db
      .prepare('SELECT rowid FROM bp_measurement_fts WHERE bp_measurement_fts MATCH ?')
      .all(matchQuery) as { rowid: number }[]
  ).map((row) => row.rowid);

/** Имена триггеров схемы (sqlite_master). */
const triggerNames = (db: EncryptedDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe('миграция v2 — FTS по заметкам (TASK-045 §19/§20)', () => {
  it('(1) v2 создаёт bp_measurement_fts (fts5=1) + 3 триггера; schema_version=2 (§19 п. 1/§20)', async () => {
    const db = await migrateFresh('fts-schema.sqlite');

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bp_measurement_fts'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const sql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bp_measurement_fts'",
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain('fts5');
    expect(sql).toContain("content='bp_measurement'");
    expect(sql).toContain("content_rowid='rowid'");

    expect(triggerNames(db)).toEqual(
      expect.arrayContaining([
        'bp_measurement_fts_ai',
        'bp_measurement_fts_ad',
        'bp_measurement_fts_au',
      ]),
    );

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('2');
    db.close();
  });

  it('(2) апгрейд реального v1-файла: backfill индексирует существующие заметки (§19/§20 AC1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v2-fts-int-'));
    dirs.push(dir);
    const path = join(dir, 'upgrade.sqlite');
    const keyHex = randomBytes(32).toString('hex');

    // Шаг 1 — схема v1 + заметки.
    const dbV1 = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: [V1_INITIAL_SCHEMA] }).migrate(dbV1);
    insertMeasurement(dbV1, 'm-old-1', 'болела голова после кофе');
    insertMeasurement(dbV1, 'm-old-2', null);
    dbV1.close();

    // Шаг 2 — открытие ТЕМ ЖЕ файлом полным реестром: v2 + backfill.
    const db = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    expect(matchRowIds(db, '"болела"')).toHaveLength(1);
    expect(matchRowIds(db, '"голова"')).toHaveLength(1);
    expect(matchRowIds(db, '"болела" "голова"')).toHaveLength(1);
    db.close();
  });

  it('(3а) AFTER INSERT: вставил с заметкой → находит; без заметки — тоже без ошибки (§19)', async () => {
    const db = await migrateFresh('insert-sync.sqlite');
    insertMeasurement(db, 'm-1', 'после кофе давление выше');
    insertMeasurement(db, 'm-2', null);

    expect(matchRowIds(db, '"кофе"')).toHaveLength(1);
    expect(matchRowIds(db, '"давление"')).toHaveLength(1);
    db.close();
  });

  it('(3б) AFTER UPDATE: обновил заметку → НОВАЯ находит, СТАРАЯ — нет (§19/§20 AC2)', async () => {
    const db = await migrateFresh('update-sync.sqlite');
    insertMeasurement(db, 'm-1', 'болела голова');

    db.prepare('UPDATE bp_measurement SET note = ? WHERE id = ?').run('болит голова', 'm-1');

    expect(matchRowIds(db, '"болит"')).toHaveLength(1);
    expect(matchRowIds(db, '"болела"')).toHaveLength(0);
    db.close();
  });

  it('(3в) AFTER DELETE: удалил → не находит (§19/§20 AC2)', async () => {
    const db = await migrateFresh('delete-sync.sqlite');
    insertMeasurement(db, 'm-1', 'болела голова');
    insertMeasurement(db, 'm-2', 'болела голова у m-2');

    db.prepare('DELETE FROM bp_measurement WHERE id = ?').run('m-1');

    expect(matchRowIds(db, '"болела"')).toHaveLength(1);
    // Удаление записи без заметки не должно ломать индекс (NULL в 'delete'-команде).
    insertMeasurement(db, 'm-3', null);
    db.prepare('DELETE FROM bp_measurement WHERE id = ?').run('m-3');
    expect(matchRowIds(db, '"болела"')).toHaveLength(1);
    db.close();
  });

  it('(4) без морфологии честно: «болит голова» ≠ «болела голова»; LIKE «болел» находит (§20 AC3)', async () => {
    const db = await migrateFresh('morphology.sqlite');
    insertMeasurement(db, 'm-1', 'болела голова');

    // Токен «болит» — точное совпадение отсутствует (нет стемминга ru, TD-IMP-3).
    expect(matchRowIds(db, '"болит" "голова"')).toHaveLength(0);
    // Точный токен «голова» находит.
    expect(matchRowIds(db, '"голова"')).toHaveLength(1);
    // LIKE-подстрока находит словоформу (fallback §13 — адаптер, здесь индекс-уровень).
    const likeHits = (
      db.prepare("SELECT id FROM bp_measurement WHERE note LIKE ? ESCAPE '\\'").all('%болел%') as {
        id: string;
      }[]
    ).map((row) => row.id);
    expect(likeHits).toEqual(['m-1']);
    db.close();
  });

  it('(5) rebuildFtsIndex — repair: идемпотентен, индекс согласован с содержимым (§8)', async () => {
    const db = await migrateFresh('rebuild.sqlite');
    insertMeasurement(db, 'm-1', 'утром 120 на 80');
    insertMeasurement(db, 'm-2', 'вечером измерение');

    rebuildFtsIndex(db);
    rebuildFtsIndex(db);

    expect(matchRowIds(db, '"утром"')).toHaveLength(1);
    expect(matchRowIds(db, '"измерение"')).toHaveLength(1);
    // Число проиндексированных строк = числу строк с заметкой (дублей нет).
    const indexed = (
      db.prepare('SELECT count(*) AS n FROM bp_measurement_fts').get() as { n: number }
    ).n;
    expect(indexed).toBe(2);
    db.close();
  });

  it('(6) реестр MIGRATIONS содержит v2 второй версией, модуль экспортирует её DDL-имя', () => {
    expect(V2_FTS_NOTES.version).toBe(2);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
  });
});
