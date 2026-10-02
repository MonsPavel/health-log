/**
 * TASK-100 §19/§20: тесты SelfCheckService (self-check старта + полная проверка).
 *
 *  - healthy tmp-БД → dbOk=true, версии заполнены (schemaVersion, vaultMode,
 *    worker, prefsOk, checkedAtUtc, startupMs ≤150 мс — AC1/§15);
 *  - повреждённая БД (байт-флип первого байта последней b-tree страницы) →
 *    dbOk=false + ОСТАЛЬНОЙ отчёт заполнен (частичная диагностика — §9/§13);
 *  - отчёт хранится в сервисе (канал app/selfcheck читает снимок — §5);
 *  - полная проверка (PRAGMA integrity_check): healthy → ok=true/details='ok';
 *    повреждённая → ok=false + details не пуст; стартовый отчёт не мутирует (§7);
 *  - лог: ОДНА info-строка резюме с {dbOk, schemaVersion, startupMs} (§18, AC1);
 *  - инвариант полей (AC5): сериализация отчёта не содержит путь БД (§14).
 *
 * Повреждённое соединение открывается в тесте напрямую через
 * better-sqlite3-multiple-ciphers (те же прагмы, что openEncrypted) — изоляция
 * от обёртки TASK-022; поведение КОНТЕЙНЕРА на повреждённой БД — отдельный
 * интеграционный тест container-selfcheck.int.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { FixedClock, type Clock } from '@hl/kernel';
import Database from 'better-sqlite3-multiple-ciphers';

import { MIGRATIONS } from '../shared/db/migrations/index.js';
import { openEncrypted, type EncryptedDatabase } from '../shared/db/sqlite.js';
import { SelfCheckService, type SelfCheckLogger } from './selfcheck.js';

/** Фиксированное «сейчас» (детерминизм checkedAtUtc). */
const NOW_MS = 1_758_816_000_000;
const KEY = 'a'.repeat(64);

/** Свежий tmp-каталог; очистка в afterAll. */
const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-selfcheck-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Логгер с записью вызовов info (§18 — проверка одной строки резюме). */
const spyLog: { infos: Array<{ message: string; meta?: object }> } = { infos: [] };
function logger(): SelfCheckLogger & { readonly infos: typeof spyLog.infos } {
  spyLog.infos = [];
  return {
    info: (message, meta) => spyLog.infos.push({ message, meta }),
    warn: () => undefined,
  } as SelfCheckLogger & { readonly infos: typeof spyLog.infos };
}

/**
 * Готовит healthy-БД с реальными миграциями + «тяжёлую» таблицу на несколько
 * страниц; возвращает соединение, размер страницы и путь файла.
 */
function makeHealthyDb(dir: string): {
  db: EncryptedDatabase;
  pageSize: number;
  file: string;
} {
  const file = join(dir, 'health-log.db');
  const db = openEncrypted(file, KEY);
  // Максимальная версия реестра — как после старта контейнера.
  db.exec(
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(MIGRATIONS.at(-1)?.version ?? 0),
  );
  // Таблица на несколько страниц: последняя страница файла — её leaf (freelist нет).
  db.exec('CREATE TABLE smoke_big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO smoke_big (v) VALUES (?)');
  db.transaction((rows: number) => {
    for (let i = 0; i < rows; i += 1) {
      insert.run(`row-${i}-payload-padding`);
    }
  })(400);
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return { db, pageSize, file };
}

/**
 * Повреждает файл БД: флип ПЕРВОГО байта последней страницы (page-type byte
 * b-tree листа → «invalid page type», детерминированно ловится quick_check).
 * Вызывается ПОСЛЕ close (WAL уже вчекпоинчен в главный файл).
 */
function corruptLastPage(file: string, pageSize: number): void {
  const bytes = readFileSync(file);
  expect(bytes.length % pageSize).toBe(0);
  const lastPageStart = bytes.length - pageSize;
  bytes[lastPageStart] = 0x00; // невалидный тип страницы b-tree
  writeFileSync(file, bytes);
}

describe('SelfCheckService — healthy старт (TASK-100 §19, AC1)', () => {
  it('dbOk=true, версии заполнены, отчёт хранится в сервисе, startupMs ≤150', async () => {
    const dir = newDir();
    const { db } = makeHealthyDb(dir);
    const clock: Clock = new FixedClock(NOW_MS, 180);
    const service = new SelfCheckService({
      db,
      clock,
      vaultMode: 'none',
      workerState: () => 'starting',
      prefsOk: async () => true,
    });

    const report = await service.run();

    expect(report.dbOk).toBe(true);
    expect(report.schemaVersion).toBe(MIGRATIONS.at(-1)?.version ?? 0);
    expect(report.vaultMode).toBe('none');
    expect(report.worker).toEqual({ state: 'starting' });
    expect(report.prefsOk).toBe(true);
    expect(report.checkedAtUtc).toBe(NOW_MS);
    expect(report.startupMs).toBeLessThanOrEqual(150);
    // Снимок хранится в сервисе (§5: хранение в контейнере — через сервис).
    expect(service.report).toEqual(report);
    // Иммутабельность снимка (§7): повторный run создаёт новый объект.
    const again = await service.run();
    expect(again).not.toBe(report);
    db.close();
  });

  it('worker без порта — поле отсутствует (§5 «если ИИ-модуль есть»)', async () => {
    const dir = newDir();
    const { db } = makeHealthyDb(dir);
    const service = new SelfCheckService({ db, clock: new FixedClock(NOW_MS, 180), vaultMode: 'passphrase' });
    const report = await service.run();
    expect(report.worker).toBeUndefined();
    expect(report.vaultMode).toBe('passphrase');
    // prefsOk без порта — true (zod-проверка при чтении контейнера не настраивалась).
    expect(report.prefsOk).toBe(true);
    db.close();
  });

  it('лог: ровно одна info-строка резюме с {dbOk, schemaVersion, startupMs} (§18)', async () => {
    const dir = newDir();
    const { db } = makeHealthyDb(dir);
    const log = logger();
    const service = new SelfCheckService({
      db,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
    });
    await service.run();
    expect(log.infos).toHaveLength(1);
    expect(log.infos[0]?.meta).toMatchObject({
      dbOk: true,
      schemaVersion: MIGRATIONS.at(-1)?.version ?? 0,
    });
    db.close();
  });

  it('инвариант полей (AC5): сериализация отчёта не содержит путь БД (§14)', async () => {
    const dir = newDir();
    const { db, file } = makeHealthyDb(dir);
    const service = new SelfCheckService({
      db,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
    });
    const report = await service.run();
    expect(JSON.stringify(report)).not.toContain(dir);
    expect(JSON.stringify(report)).not.toContain(file);
    db.close();
  });
});

describe('SelfCheckService — повреждённая БД (TASK-100 §9/§19, AC2)', () => {
  it('quick_check≠ok → dbOk=false, остальной отчёт заполнен (частичная диагностика)', async () => {
    const dir = newDir();
    const { db, pageSize, file } = makeHealthyDb(dir);
    db.close();
    corruptLastPage(file, pageSize);

    // Открываем соединение напрямую (прагмы openEncrypted): при верном ключе
    // повреждение НЕ бросает — отчёт quick_check приходит строкой.
    const corrupt = new Database(file);
    corrupt.pragma("cipher = 'sqlcipher'");
    corrupt.pragma(`key = "x'${KEY}'"`);
    const quick = corrupt.pragma('quick_check', { simple: true });
    expect(quick).not.toBe('ok'); // предусловие: фикстура реально повреждена

    const service = new SelfCheckService({
      db: corrupt as unknown as EncryptedDatabase,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
      prefsOk: async () => true,
    });
    const report = await service.run();

    expect(report.dbOk).toBe(false);
    // Остальное заполнено (§13: частичная диагностика, не пустой отчёт).
    expect(report.schemaVersion).toBe(MIGRATIONS.at(-1)?.version ?? 0);
    expect(report.vaultMode).toBe('none');
    expect(report.prefsOk).toBe(true);
    expect(report.checkedAtUtc).toBe(NOW_MS);
    corrupt.close();
  });

  it('prefsOk-порт, бросивший отказ, даёт false (флаг zod-валидации при чтении)', async () => {
    const dir = newDir();
    const { db } = makeHealthyDb(dir);
    const service = new SelfCheckService({
      db,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
      prefsOk: async () => {
        throw new Error('STORAGE/BOOM');
      },
    });
    const report = await service.run();
    expect(report.dbOk).toBe(true);
    expect(report.prefsOk).toBe(false);
    db.close();
  });
});

describe('SelfCheckService — полная проверка (TASK-100 §4/§7/§11, AC4)', () => {
  it('healthy → {ok: true, details: "ok"}; стартовый отчёт не мутирует (§7)', async () => {
    const dir = newDir();
    const { db } = makeHealthyDb(dir);
    const service = new SelfCheckService({
      db,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
    });
    const before = await service.run();
    const full = await service.runFullIntegrity();
    expect(full).toEqual({ ok: true, details: 'ok' });
    expect(service.report).toEqual(before);
    db.close();
  });

  it('повреждённая БД → {ok: false, details} с текстом ошибки (для раскрытия 101)', async () => {
    const dir = newDir();
    const { db, pageSize, file } = makeHealthyDb(dir);
    db.close();
    corruptLastPage(file, pageSize);
    const corrupt = new Database(file);
    corrupt.pragma("cipher = 'sqlcipher'");
    corrupt.pragma(`key = "x'${KEY}'"`);
    const service = new SelfCheckService({
      db: corrupt as unknown as EncryptedDatabase,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
    });
    const full = await service.runFullIntegrity();
    expect(full.ok).toBe(false);
    expect(full.details.length).toBeGreaterThan(0);
    expect(full.details).not.toBe('ok');
    corrupt.close();
  });

  it('полная проверка — отдельный запрос: каждый вызов перечитывает БД (§11)', async () => {
    const dir = newDir();
    const { db } = makeHealthyDb(dir);
    const pragmaSpy = vi.spyOn(db, 'pragma');
    const service = new SelfCheckService({
      db,
      clock: new FixedClock(NOW_MS, 180),
      vaultMode: 'none',
    });
    await service.runFullIntegrity();
    await service.runFullIntegrity();
    const integrityCalls = pragmaSpy.mock.calls.filter(([source]) => source === 'integrity_check');
    expect(integrityCalls).toHaveLength(2);
    db.close();
  });
});
