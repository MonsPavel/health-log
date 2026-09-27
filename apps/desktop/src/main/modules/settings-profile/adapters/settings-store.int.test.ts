// TASK-047 §5/§14/§19: интеграционные тесты адаптера SettingsStore — KV-хранилище
// настроек над таблицей app_setting миграции v3 (tmp-каталог, реальный SQLCipher-стек,
// прецедент notes-search.int.test.ts). Матрица:
//  1. get отсутствующего ключа → undefined (дефолт подставляет сервис, §5);
//  2. set пишет value_json + updated_at_utc (FixedClock); чтение схемой парсит JSON;
//  3. повторный set — UPSERT: значение и updated_at_utc обновлены, строка одна;
//  4. повреждённый JSON → undefined + warn (§20 AC3: без креша);
//  5. валидный JSON не по схеме → undefined + warn;
//  6. отказ записи (БД закрыта) → AppError STORAGE/FAILED (§9: наружу только коды).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppError, FixedClock } from '@hl/kernel';

import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { SettingsStore } from './settings-store.js';

/** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Свежая БД на актуальной схеме + адаптер с FixedClock и spy-логгером. */
const makeStore = async (name: string, nowMs: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-settings-store-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const store = new SettingsStore(db, { clock: new FixedClock(nowMs, 180), logger });
  return { db, store, logger };
};

/** Схема-валидатор значения для тестов: {value: string}. */
const PayloadSchema = z.object({ value: z.string() }).strict();

describe('SettingsStore — get/set по ключу над app_setting (TASK-047 §5/§19)', () => {
  it('(1) отсутствующий ключ → undefined (дефолт подставит сервис, §5)', async () => {
    const { db, store } = await makeStore('missing.sqlite', 1_700_000_000_000);

    expect(store.get('prefs', PayloadSchema)).toBeUndefined();
    db.close();
  });

  it('(2) set пишет value_json и updated_at_utc из Clock; get парсит схемой', async () => {
    const nowMs = 1_700_000_123_456;
    const { db, store } = await makeStore('set.sqlite', nowMs);

    await store.set('prefs', JSON.stringify({ value: 'ок' }));

    const row = db.prepare('SELECT value_json, updated_at_utc FROM app_setting WHERE key = ?').get(
      'prefs',
    ) as { value_json: string; updated_at_utc: number };
    expect(row.value_json).toBe('{"value":"ок"}');
    expect(row.updated_at_utc).toBe(nowMs);
    expect(store.get('prefs', PayloadSchema)).toEqual({ value: 'ок' });
    db.close();
  });

  it('(3) повторный set — UPSERT: строка одна, значение и время обновлены', async () => {
    const { db, store } = await makeStore('upsert.sqlite', 1_700_000_000_000);

    await store.set('prefs', '{"value":"первое"}');
    await store.set('prefs', '{"value":"второе"}');

    const rows = db.prepare('SELECT count(*) AS n FROM app_setting').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(store.get('prefs', PayloadSchema)).toEqual({ value: 'второе' });
    db.close();
  });

  it('(4) повреждённый JSON → undefined + warn, без креша (§20 AC3)', async () => {
    const { db, store, logger } = await makeStore('corrupt-json.sqlite', 1_700_000_000_000);

    await store.set('prefs', '{"value":"ок"}');
    db.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run('{not json', 'prefs');

    expect(store.get('prefs', PayloadSchema)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('(5) валидный JSON вне схемы → undefined + warn (zod-валидация каждого чтения, §14)', async () => {
    const { db, store, logger } = await makeStore('corrupt-shape.sqlite', 1_700_000_000_000);

    await store.set('prefs', '{"value":42}');
    db.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run('{"value":42}', 'prefs');

    expect(store.get('prefs', PayloadSchema)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('(6) отказ записи → AppError STORAGE/FAILED (§9)', async () => {
    const { db, store } = await makeStore('write-fail.sqlite', 1_700_000_000_000);
    db.close(); // дескриптор закрыт — запись обязана упасть

    const error: unknown = await store.set('prefs', '{}').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE/FAILED');
  });
});
