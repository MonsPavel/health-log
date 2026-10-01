// TASK-089 §19/§20: интеграционные тесты миграции v7 chat_message — история чата
// (tmp-каталог, реальный SQLCipher-стек: openEncrypted → MigrationRunner с РЕАЛЬНЫМ
// реестром MIGRATIONS — тот же путь, что у приложения; прецедент v6 TASK-087).
//
// Матрица (§19):
//  1. v7 создаёт таблицу chat_message (sqlite_master); DDL поимённо (§5/§8):
//     id TEXT PK, profile_id NOT NULL (+FK profile), role NOT NULL CHECK
//     ('user'|'assistant'), content NOT NULL, refusal_class NULL (пометка
//     refusal-ответов, §7), created_at_utc NOT NULL + индекс
//     chat_message_profile_created_idx (profile_id, created_at_utc DESC);
//     schema_version = 7;
//  2. вставка/чтение строки работают (NULL refusal_class читается как NULL);
//     CHECK (role) отбраковывает чужую роль (§8);
//  3. профиль «последние N по времени» идёт по индексу (profile_id,
//     created_at_utc DESC) — smoke порядка listRecent (порт TASK-089, §5);
//  4. повторное применение полного реестра — no-op (идемпотентность runner'а, §20);
//  5. апгрейд существующего v1-файла (с данными) реестром MIGRATIONS: измерения
//     целы, chat_message пуста;
//  6. реестр MIGRATIONS содержит версии [1..7]; V7_CHAT_MESSAGE.version === 7 (§4/§5).
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14); ключ генерируется в тесте (§5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { V7_CHAT_MESSAGE } from './v7-chat.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'hl-v7-chat-int-'));
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

describe('миграция v7 — chat_message (TASK-089 §19/§20)', () => {
  it('(1) v7 создаёт таблицу chat_message и индекс (profile_id, created_at_utc desc); DDL поимённо; schema_version=7', async () => {
    const db = await migrateFresh('v7-schema.sqlite');

    expect(tableExists(db, 'chat_message')).toBe(true);

    const columns = tableColumns(db, 'chat_message');
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'profile_id',
      'role',
      'content',
      'refusal_class',
      'created_at_utc',
    ]);
    expect(columns.map((c) => c.type)).toEqual([
      'TEXT',
      'TEXT',
      'TEXT',
      'TEXT',
      'TEXT',
      'INTEGER',
    ]);
    // PK неявно NOT NULL (0); refusal_class — ЕДИНСТВЕННАЯ допускающая NULL колонка (§5);
    // остальные NOT NULL.
    expect(columns.map((c) => c.notnull)).toEqual([0, 1, 1, 1, 0, 1]);
    expect(columns.map((c) => c.pk)).toEqual([1, 0, 0, 0, 0, 0]);

    // FK на profile(id) — как в v6 (внешние ключи SQLite по умолчанию выключены,
    // constraint — декларация схемы; валидация скоупа — порты/use case).
    const fk = db.prepare('PRAGMA foreign_key_list(chat_message)').all() as {
      table: string;
      from: string;
      to: string;
    }[];
    expect(fk.map(({ table, from, to }) => ({ table, from, to }))).toEqual([
      { table: 'profile', from: 'profile_id', to: 'id' },
    ]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_message' " +
          "AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(['chat_message_profile_created_idx']);
    const indexInfo = db.prepare('PRAGMA index_info(chat_message_profile_created_idx)').all() as {
      name: string;
    }[];
    expect(indexInfo.map((c) => c.name)).toEqual(['profile_id', 'created_at_utc']);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('7');
    db.close();
  });

  it('(2) вставка/чтение строки работают (refusal_class NULL); CHECK (role) отбраковывает чужую роль (§8)', async () => {
    const db = await migrateFresh('v7-rows.sqlite');
    const insert = db.prepare(
      'INSERT INTO chat_message (id, profile_id, role, content, refusal_class, created_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    // Обычный ход: refusal_class NULL.
    insert.run('m-user', 'seed-profile-0001', 'user', 'Почему вечером выше?', null, 1000);
    // refusal-ответ: класс отказа в refusal_class (§7 — пометка для UI 088).
    insert.run('m-bot', 'seed-profile-0001', 'assistant', 'Я не определяю заболевания.', 'diagnosis', 1001);

    const rows = db
      .prepare(
        'SELECT id, profile_id, role, content, refusal_class, created_at_utc ' +
          'FROM chat_message ORDER BY created_at_utc',
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        id: 'm-user',
        profile_id: 'seed-profile-0001',
        role: 'user',
        content: 'Почему вечером выше?',
        refusal_class: null,
        created_at_utc: 1000,
      },
      {
        id: 'm-bot',
        profile_id: 'seed-profile-0001',
        role: 'assistant',
        content: 'Я не определяю заболевания.',
        refusal_class: 'diagnosis',
        created_at_utc: 1001,
      },
    ]);

    // CHECK (role IN ('user','assistant')) — чужая роль не проходит (§5 DDL).
    expect(() => insert.run('m-bad', 'seed-profile-0001', 'system', 'x', null, 1)).toThrow();
    db.close();
  });

  it('(3) порядок «последние N» (profile_id, created_at_utc DESC) — новейшая строка первая', async () => {
    const db = await migrateFresh('v7-recent.sqlite');
    const insert = db.prepare(
      'INSERT INTO chat_message (id, profile_id, role, content, refusal_class, created_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    const seedProfile = 'seed-profile-0001';
    insert.run('m-old', seedProfile, 'user', 'старый', null, 1000);
    insert.run('m-new', seedProfile, 'assistant', 'новый', null, 3000);
    insert.run('m-mid', seedProfile, 'user', 'средний', null, 2000);

    // Профиль listRecent (§5): последние N по (created_at_utc DESC), LIMIT N.
    const recent = db
      .prepare(
        'SELECT id FROM chat_message WHERE profile_id = ? ' +
          'ORDER BY created_at_utc DESC, rowid DESC LIMIT 2',
      )
      .all(seedProfile) as { id: string }[];
    expect(recent.map((row) => row.id)).toEqual(['m-new', 'm-mid']);
    db.close();
  });

  it('(4) повторное применение полного реестра — no-op: содержимое цело, версия прежняя', async () => {
    const db = await migrateFresh('v7-reapply.sqlite');
    db.prepare(
      'INSERT INTO chat_message (id, profile_id, role, content, refusal_class, created_at_utc) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m-1', 'seed-profile-0001', 'user', 'вопрос', null, 1);

    await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);

    const rows = db.prepare('SELECT count(*) AS n FROM chat_message').get() as { n: number };
    expect(rows.n).toBe(1);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('7');
    db.close();
  });

  it('(5) апгрейд v1-файла с данными реестром MIGRATIONS: измерения целы, chat_message пуста', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-v7-chat-int-'));
    dirs.push(dir);
    const path = join(dir, 'upgrade.sqlite');
    const keyHex = randomBytes(32).toString('hex');

    // Шаг 1 — схема v1 + измерение (жизнь до v7).
    const dbV1 = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: [V1_INITIAL_SCHEMA] }).migrate(dbV1);
    dbV1
      .prepare(
        'INSERT INTO bp_measurement ' +
          "(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) VALUES ('m-1', 'seed-profile-0001', 1, 180, 120, 80, 60, 0, 'left', NULL, 'manual', 1, 1)",
      )
      .run();
    dbV1.close();

    // Шаг 2 — открытие ТЕМ ЖЕ файлом полным реестром: v2…v7.
    const db = openEncrypted(path, keyHex);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    const measurements = db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as {
      n: number;
    };
    expect(measurements.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM chat_message').get()).toEqual({ n: 0 });
    db.close();
  });

  it('(6) реестр MIGRATIONS — версии [1, 2, 3, 4, 5, 6, 7]; V7_CHAT_MESSAGE.version === 7 (§4/§5)', () => {
    expect(V7_CHAT_MESSAGE.version).toBe(7);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
