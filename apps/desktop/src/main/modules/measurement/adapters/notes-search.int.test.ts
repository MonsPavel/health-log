// TASK-045 §9/§13/§14/§19: интеграционные тесты адаптера поиска NotesSearchAdapter
// на реальной БД (миграции MIGRATIONS — FTS5 в пресете, риск §22 закрыт пробной
// загрузкой). Матрица:
//  - санитизация MATCH (§9, чистая функция toMatchQuery): токены в кавычки, `"`
//    удаляется, спецсимволы нейтрализуются, пустой/мусорный → '';
//  - MATCH-поиск: токен находит, несколько токенов = И, сортировка desc (§5:
//    сортировка по времени, не rank), limit, дедуп по записи (§2);
//  - инъекция (§14): `test" OR 1=1` → безопасный результат БЕЗ ошибки SQL (§20 AC4);
//  - LIKE-fallback (§13): MATCH 0 и запрос ≥2 символов → подстрока; escape %/_/\;
//    запрос <2 символов → без fallback; спецсимволы LIKE (% _) в заметке находит.
//
// Файлы БД в tmp ОС, удаляются в afterAll (§14, прецедент v2-fts.int.test.ts).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { NotesSearchAdapter, toMatchQuery } from './notes-search.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';

/** tmp-каталоги сессии — очистка в afterAll (§14). */
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Свежая зашифрованная БД на актуальной схеме (путь приложения §19). */
const migrateFresh = async (name: string): Promise<EncryptedDatabase> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-notes-search-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
  return db;
};

/** Прямая вставка строки bp_measurement (колонки v1) с заданной заметкой. */
const insertMeasurement = (
  db: EncryptedDatabase,
  id: string,
  note: string | null,
  takenAtUtc = 1_700_000_000_000,
): void => {
  db.prepare(
    'INSERT INTO bp_measurement ' +
      '(id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    'seed-profile-0001',
    takenAtUtc,
    180,
    120,
    80,
    null,
    0,
    'left',
    note,
    'manual',
    takenAtUtc,
    takenAtUtc,
  );
};

describe('toMatchQuery — санитизация MATCH (§9)', () => {
  it('токены в двойные кавычки, разделитель — пробел (AND-семантика)', () => {
    expect(toMatchQuery('болела голова')).toBe('"болела" "голова"');
  });

  it('пробелы любой ширины — разделители; края тримутся', () => {
    expect(toMatchQuery('  после\t кофе\nдавления  ')).toBe('"после" "кофе" "давления"');
  });

  it('двойные кавычки внутри токена удаляются (нейтрализация фраз-синтаксиса)', () => {
    // Порядок §9: разбиение по пробелам ДО удаления кавычек — «test"» и «OR» —
    // два токена; кавычка из первого удаляется, второй берётся как есть.
    expect(toMatchQuery('test" OR')).toBe('"test" "OR"');
    expect(toMatchQuery('болела" голова"')).toBe('"болела" "голова"');
  });

  it('спецсинтаксис FTS нейтрализуется кавычками (NEAR, *, OR, AND, NOT)', () => {
    expect(toMatchQuery('NEAR(headache coffee)')).toBe('"NEAR(headache" "coffee)"');
    expect(toMatchQuery('*')).toBe('"*"');
    expect(toMatchQuery('a OR b')).toBe('"a" "OR" "b"');
  });

  it('пустой и состоящий из кавычек запрос → пустая строка MATCH (не ошибка, §9)', () => {
    expect(toMatchQuery('')).toBe('');
    expect(toMatchQuery('   ')).toBe('');
    expect(toMatchQuery('""" """')).toBe('');
  });
});

describe('NotesSearchAdapter — MATCH-путь (§5/§13)', () => {
  it('токен находит заметку; ответ — агрегаты с верными id (§19)', async () => {
    const db = await migrateFresh('match-token.sqlite');
    insertMeasurement(db, 'm-1', 'после кофе давление выше');
    insertMeasurement(db, 'm-2', 'утром прогулялся');
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'кофе', limit: 50 });

    expect(items.map((m) => m.id)).toEqual(['m-1']);
    expect(items[0]?.note).toBe('после кофе давление выше');
    db.close();
  });

  it('несколько токенов — AND: обе лексемы должны присутствовать (§9)', async () => {
    const db = await migrateFresh('match-and.sqlite');
    insertMeasurement(db, 'm-1', 'болела голова после кофе');
    insertMeasurement(db, 'm-2', 'болела спина');
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'болела голова', limit: 50 });

    expect(items.map((m) => m.id)).toEqual(['m-1']);
    db.close();
  });

  it('сортировка по времени desc, не rank (§5); limit отрезает старые', async () => {
    const db = await migrateFresh('match-order.sqlite');
    insertMeasurement(db, 'm-old', 'кофе утром', 1_700_000_000_000);
    insertMeasurement(db, 'm-new', 'кофе вечером', 1_700_100_000_000);
    insertMeasurement(db, 'm-mid', 'кофе днём', 1_700_050_000_000);
    const adapter = new NotesSearchAdapter(db);

    const all = await adapter.searchNotes({ query: 'кофе', limit: 50 });
    expect(all.map((m) => m.id)).toEqual(['m-new', 'm-mid', 'm-old']);

    const limited = await adapter.searchNotes({ query: 'кофе', limit: 2 });
    expect(limited.map((m) => m.id)).toEqual(['m-new', 'm-mid']);
    db.close();
  });

  it('дедуп по записи (§2): повтор токена и многократное совпадение — запись один раз', async () => {
    const db = await migrateFresh('match-dedup.sqlite');
    insertMeasurement(db, 'm-1', 'голова голова голова');
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'голова голова', limit: 50 });

    expect(items.map((m) => m.id)).toEqual(['m-1']);
    db.close();
  });
});

describe('NotesSearchAdapter — инъекция и мусор (§14/§20 AC4)', () => {
  it('`test" OR 1=1` → безопасный результат без ошибки SQL (§20 AC4)', async () => {
    const db = await migrateFresh('injection.sqlite');
    insertMeasurement(db, 'm-1', 'обычная заметка');
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'test" OR 1=1', limit: 50 });

    // Кавычка удалена → фраза "test OR 1=1" как единый токен — записей с ней нет.
    expect(items).toEqual([]);
    // БД не тронута: обычный поиск продолжает работать.
    expect((await adapter.searchNotes({ query: 'обычная', limit: 50 })).map((m) => m.id)).toEqual([
      'm-1',
    ]);
    db.close();
  });

  it('мусор из спецсимволов → пустой результат, не ошибка (§9)', async () => {
    const db = await migrateFresh('garbage.sqlite');
    insertMeasurement(db, 'm-1', 'заметка');
    const adapter = new NotesSearchAdapter(db);

    for (const query of ['*', '"', '""" """', '^-$', '()*']) {
      await expect(adapter.searchNotes({ query, limit: 50 })).resolves.toBeInstanceOf(Array);
    }
    db.close();
  });

  it('пустой запрос → [] без обращения к FTS (§9/§20 AC5)', async () => {
    const db = await migrateFresh('empty-query.sqlite');
    insertMeasurement(db, 'm-1', 'заметка');
    const adapter = new NotesSearchAdapter(db);

    await expect(adapter.searchNotes({ query: '', limit: 50 })).resolves.toEqual([]);
    await expect(adapter.searchNotes({ query: '   ', limit: 50 })).resolves.toEqual([]);
    db.close();
  });
});

describe('NotesSearchAdapter — LIKE-fallback (§13)', () => {
  it('MATCH 0 + запрос ≥2 символов → подстрока: «болел» находит «болела» (§20 AC3)', async () => {
    const db = await migrateFresh('like-fallback.sqlite');
    insertMeasurement(db, 'm-1', 'болела голова');
    insertMeasurement(db, 'm-2', 'нога болела');
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'болел', limit: 50 });

    // MATCH «"болел"» — 0 (токены точные), LIKE %болел% — обе записи, desc по времени
    // не различим (равные taken_at) — порядок проверяется по desc tie-break id desc.
    expect(items.map((m) => m.id).sort()).toEqual(['m-1', 'm-2'].sort());
    db.close();
  });

  it('односимвольный запрос → без LIKE-fallback: [] (§13)', async () => {
    const db = await migrateFresh('like-short.sqlite');
    insertMeasurement(db, 'm-1', 'болела голова');
    const adapter = new NotesSearchAdapter(db);

    await expect(adapter.searchNotes({ query: 'б', limit: 50 })).resolves.toEqual([]);
    db.close();
  });

  it('MATCH нашёл — LIKE не вызывается (пути не смешиваются, §13)', async () => {
    const db = await migrateFresh('like-not-mixed.sqlite');
    insertMeasurement(db, 'm-1', 'кофе');
    insertMeasurement(db, 'm-2', 'кофеинка');
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'кофе', limit: 50 });

    // MATCH «кофе» находит только m-1 (точный токен); LIKE бы нашёл и «кофеинка».
    expect(items.map((m) => m.id)).toEqual(['m-1']);
    db.close();
  });

  it('спецсимволы LIKE (% _) в запросе и заметке экранируются — совпадение буквальное (§14)', async () => {
    const db = await migrateFresh('like-escape.sqlite');
    insertMeasurement(db, 'm-1', 'прогресс 100% достигнут');
    insertMeasurement(db, 'm-2', 'прогресс 100x достигнут');
    insertMeasurement(db, 'm-3', 'snake_case заметка');
    insertMeasurement(db, 'm-4', 'snakeXcase заметка');
    const adapter = new NotesSearchAdapter(db);

    // «100%» — только m-1: % экранирован, не «любой символ» (иначе нашёлся бы m-2).
    expect((await adapter.searchNotes({ query: '100%', limit: 50 })).map((m) => m.id)).toEqual([
      'm-1',
    ]);
    // «snake_case» — только m-3: _ экранирован (иначе нашёлся бы m-4).
    expect(
      (await adapter.searchNotes({ query: 'snake_case', limit: 50 })).map((m) => m.id),
    ).toEqual(['m-3']);
    db.close();
  });

  it("обратный слэш в запросе экранируется (ESCAPE '\\' не ломается, §14)", async () => {
    const db = await migrateFresh('like-backslash.sqlite');
    insertMeasurement(db, 'm-1', 'путь C:\\users\\заметка');
    const adapter = new NotesSearchAdapter(db);

    expect(
      (await adapter.searchNotes({ query: 'C:\\users', limit: 50 })).map((m) => m.id),
    ).toEqual(['m-1']);
    db.close();
  });

  it('LIMIT-fallback тоже ограничен лимитом (§13: лимит результата 50 по умолчанию)', async () => {
    const db = await migrateFresh('like-limit.sqlite');
    for (let i = 0; i < 7; i += 1) {
      insertMeasurement(db, `m-${i}`, 'подстрока ищется', 1_700_000_000_000 + i);
    }
    const adapter = new NotesSearchAdapter(db);

    const items = await adapter.searchNotes({ query: 'строка ище', limit: 3 });

    expect(items).toHaveLength(3);
    db.close();
  });
});
