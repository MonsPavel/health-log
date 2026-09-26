/**
 * TASK-022 §19: интеграционные тесты SQLCipher-стека better-sqlite3 (tmp-каталог).
 *
 * Матрица (§19/§20):
 *  - roundtrip: create → insert → close → reopen с ключом → данные читаются;
 *  - reopen с неверным ключом → AppError STORAGE/BAD_KEY (не сырая ошибка, §7/§13);
 *  - reopen БЕЗ ключа → ожидаемое исключение SQLITE_NOTADB (то, что обёртка маппит
 *    в STORAGE/BAD_KEY);
 *  - первые 16 байт файла ≠ SQLite-магии «SQLite format 3» — шифрование в покое (§20);
 *  - WAL-файлы создаются, journal_mode=wal переживает переоткрытие (§8/§19);
 *  - файл занят другим соединением → STORAGE/LOCKED (§13 — здесь только код ошибки);
 *  - замер 1000 вставок в транзакции ≤ 1 с — базовая линия для ADR-0002 (§15/§20);
 *  - валидация keyHex (§7: ключ — hex 64 символа) — TypeError в точке вызова
 *    (dev-контракт, прецедент §20: скоуп profileId TASK-021).
 *
 * Ключ генерируется в тесте (§5: KeyVault — TASK-023); файлы в tmp ОС, удаляются
 * в afterAll (§14).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '@hl/kernel';

import Database from 'better-sqlite3-multiple-ciphers';

import { openEncrypted } from './sqlite.js';

/** Случайный ключ БД: 32 байта = 64 hex-символа (§7). */
const randomKeyHex = (): string => randomBytes(32).toString('hex');

describe('openEncrypted: SQLCipher-стек (TASK-022 §19/§20)', () => {
  /** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Свежий tmp-каталог на тест (изоляция сценариев друг от друга). */
  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-sqlite-int-'));
    dirs.push(dir);
    return dir;
  };

  /** Читает код ошибки из SqliteError (better-sqlite3) — не полагаясь на типы. */
  const sqliteErrorCode = (error: unknown): string | undefined =>
    (error as { code?: string } | null)?.code;

  it('roundtrip: create → insert → close → reopen с ключом → данные читаются (§19/§20)', () => {
    const file = join(newDir(), 'roundtrip.sqlite');
    const key = randomKeyHex();

    const db = openEncrypted(file, key);
    db.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    db.prepare('INSERT INTO smoke (v) VALUES (?)').run('hello-sqlcipher');
    db.close();

    const reopened = openEncrypted(file, key);
    const row = reopened.prepare('SELECT v FROM smoke').get() as { v: string };
    expect(row.v).toBe('hello-sqlcipher');
    reopened.close();
  });

  it('неверный ключ → AppError STORAGE/BAD_KEY, не сырая ошибка (§7/§13/§20)', () => {
    const file = join(newDir(), 'wrong-key.sqlite');
    const db = openEncrypted(file, randomKeyHex());
    db.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    db.close();

    let thrown: unknown;
    try {
      openEncrypted(file, randomKeyHex());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('STORAGE/BAD_KEY');
  });

  it('открытие БЕЗ ключа → SqliteError SQLITE_NOTADB — исключение, которое маппится в BAD_KEY (§19)', () => {
    const file = join(newDir(), 'no-key.sqlite');
    const db = openEncrypted(file, randomKeyHex());
    db.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    db.close();

    const raw = new Database(file);
    let thrown: unknown;
    try {
      raw.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    } catch (error) {
      thrown = error;
    } finally {
      raw.close();
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(sqliteErrorCode(thrown)).toBe('SQLITE_NOTADB');
  });

  it('первые 16 байт файла ≠ «SQLite format 3\\0» — файл зашифрован (§20)', () => {
    const file = join(newDir(), 'header.sqlite');
    const db = openEncrypted(file, randomKeyHex());
    db.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    db.prepare('INSERT INTO smoke (v) VALUES (?)').run('x');
    db.close();

    const header = readFileSync(file).subarray(0, 16).toString('latin1');
    expect(header).not.toBe('SQLite format 3\0');
  });

  it('WAL-файлы создаются; journal_mode=wal переживает переоткрытие (§8/§19)', () => {
    const file = join(newDir(), 'wal.sqlite');
    const key = randomKeyHex();

    const db = openEncrypted(file, key);
    db.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    db.prepare('INSERT INTO smoke (v) VALUES (?)').run('x');
    // WAL-файлы живут, пока соединение открыто (при корректном close SQLite их убирает).
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(existsSync(`${file}-shm`)).toBe(true);
    db.close();

    const reopened = openEncrypted(file, key);
    expect(reopened.pragma('journal_mode', { simple: true })).toBe('wal');
    reopened.close();
  });

  it('файл занят другим соединением (BEGIN EXCLUSIVE) → STORAGE/LOCKED (§13)', () => {
    const file = join(newDir(), 'locked.sqlite');
    const key = randomKeyHex();
    const holder = openEncrypted(file, key);
    holder.exec('CREATE TABLE smoke (v TEXT NOT NULL)');
    // В WAL вторая связь читает параллельно — BUSY на открытии не получить; на время
    // теста переводим файл в rollback-journal режим: BEGIN EXCLUSIVE там блокирует
    // и чтение другой связи → детерминированный SQLITE_BUSY при openEncrypted.
    holder.pragma('journal_mode = DELETE');
    holder.exec('BEGIN EXCLUSIVE');
    let thrown: unknown;
    try {
      openEncrypted(file, key);
    } catch (error) {
      thrown = error;
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('STORAGE/LOCKED');
  });

  it('1000 вставок в транзакции ≤ 1000 мс — базовая линия ADR-0002 (§15/§20)', () => {
    const file = join(newDir(), 'perf.sqlite');
    const db = openEncrypted(file, randomKeyHex());
    db.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    const started = performance.now();
    const insert = db.prepare('INSERT INTO smoke (v) VALUES (?)');
    db.transaction((rows: number) => {
      for (let i = 0; i < rows; i += 1) {
        insert.run(`row-${i}`);
      }
    })(1000);
    const durationMs = performance.now() - started;

    // Значение фиксируется в ADR-0002 как базовая линия (§15); в тесте — порог ≤1 с.
    console.info(`[TASK-022] 1000 encrypted inserts in txn: ${durationMs.toFixed(1)} ms`);
    expect(durationMs).toBeLessThanOrEqual(1000);
    expect(db.prepare('SELECT count(*) AS n FROM smoke').get()).toEqual({ n: 1000 });
    db.close();
  });

  it('keyHex не 64 hex-символа → TypeError до обращения к файлу (§7, dev-контракт)', () => {
    const file = join(newDir(), 'bad-key.sqlite');
    expect(() => openEncrypted(file, 'not-hex-at-all')).toThrow(TypeError);
    // 32 hex-символа (16 байт) — неверная длина.
    expect(() => openEncrypted(file, randomBytes(16).toString('hex'))).toThrow(TypeError);
    expect(existsSync(file)).toBe(false);
  });
});
