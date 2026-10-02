// TASK-102 §5/§9/§11/§14/§19: юнит-тесты test-хуков крэш-теста NFR-3 (main-сторона).
// Матрица:
//  - гард testHooksEnabled (§11/§14): без HL_TEST_HOOKS=1 — false; с флагом и не
//    packaged — true; в packaged-эмуляции — false даже с флагом (двойная защита,
//    §20 AC4 «каналы отсутствуют без env-флага и в packaged»);
//  - хендлер insert-batch (§9): ОДНА транзакция на батч (атомарность — основа
//    инварианта «count == ack ИЛИ ack + размер батча», §8), insert + bump
//    data_version ЗА КАЖДУЮ запись (формула dv == 1 + count, §8), ответ —
//    подтверждённый total строк (ack-оракул), id уникальны в пределах хендлера;
//  - хендлер db-state (§8/§11): снимок {count, dataVersion, schemaVersion} —
//    факты чтения meta/bp_measurement, отсутствие строк meta — честные нули.
import { describe, expect, it } from 'vitest';

import type { TestInsertBatchRequest } from '@hl/contracts';

import {
  createTestDbStateHandler,
  createTestInsertBatchHandler,
  HL_TEST_HOOKS_ENV,
  testHooksEnabled,
} from './test-hooks.js';

describe('testHooksEnabled — гард регистрации test-каналов (§11/§14, §20 AC4)', () => {
  it('без HL_TEST_HOOKS=1 регистрация пропускается — каналы отсутствуют (§20 AC4)', () => {
    expect(testHooksEnabled({}, false)).toBe(false);
    expect(testHooksEnabled({ [HL_TEST_HOOKS_ENV]: '0' }, false)).toBe(false);
    expect(testHooksEnabled({ [HL_TEST_HOOKS_ENV]: '' }, false)).toBe(false);
    expect(testHooksEnabled({ [HL_TEST_HOOKS_ENV]: '1' }, false)).toBe(true);
  });

  it('в packaged-режиме env игнорируется — двойная защита (§14: тест-эмуляция isPackaged)', () => {
    expect(testHooksEnabled({ [HL_TEST_HOOKS_ENV]: '1' }, true)).toBe(false);
  });
});

describe('createTestInsertBatchHandler — транзакционный батч (§9)', () => {
  /**
   * Fake-БД в форме better-sqlite3 (transaction + prepare.run/get): механика §19,
   * прецедент bench-seed.test.ts. ЧЕСТНЫЙ контракт better-sqlite3: transaction(fn)
   * ВОЗВРАЩАЕТ транзакционную функцию — счётчик растёт при её ВЫЗОВЕ (иначе тест
   * маскирует промах «создал транзакцию, не вызвал»). get считает ПОСЛЕ run:
   * state растёт — COUNT/data_version/schema_version читаются по текущему state.
   */
  function fakeDb(
    initial: { count: number; dataVersion: number; schemaVersion: number } = {
      count: 0,
      dataVersion: 1,
      schemaVersion: 7,
    },
  ) {
    const runParams: Record<string, unknown>[] = [];
    const preparedSql: string[] = [];
    let transactions = 0;
    const state = { ...initial };
    return {
      runParams,
      preparedSql,
      transactions: () => transactions,
      state: () => state,
      transaction(fn: () => unknown): () => unknown {
        return () => {
          transactions += 1;
          fn();
          return undefined;
        };
      },
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          run(params: Record<string, unknown> = {}): unknown {
            if (sql.includes('INSERT INTO bp_measurement')) {
              state.count += 1;
              runParams.push(params);
            } else if (sql.includes('UPDATE meta SET value')) {
              state.dataVersion += 1;
            }
            return { changes: 1 };
          },
          get(): unknown {
            if (sql.includes('COUNT(*)')) {
              return { total: state.count };
            }
            if (sql.includes("'data_version'")) {
              return { value: String(state.dataVersion) };
            }
            if (sql.includes("'schema_version'")) {
              return { value: String(state.schemaVersion) };
            }
            return undefined;
          },
        };
      },
    };
  }

  it('готовит INSERT строки bp_measurement v1 + bump data_version (§8/§9)', () => {
    const db = fakeDb();
    createTestInsertBatchHandler(db)({ count: 1 });
    expect(db.preparedSql.some((sql) => sql.includes('INSERT INTO bp_measurement'))).toBe(true);
    expect(db.preparedSql.some((sql) => sql.includes('UPDATE meta SET value'))).toBe(true);
  });

  it('вставляет count строк ОДНОЙ транзакцией, bump — за каждую запись (dv == 1 + count, §8)', () => {
    const db = fakeDb();
    const request: TestInsertBatchRequest = { count: 50 };
    const response = createTestInsertBatchHandler(db)(request);
    expect(db.transactions()).toBe(1);
    expect(db.runParams).toHaveLength(50);
    // Формула §8 на состоянии fake-БД: dv = 1 (база) + count.
    expect(db.state().dataVersion).toBe(1 + 50);
    expect(response).toEqual({ committedTotal: 50 });
  });

  it('total в ответе — ПОДТВЕРЖДЁННЫЙ COUNT после транзакции, а не эхо запроса (ack-оракул §2)', () => {
    const db = fakeDb({ count: 500, dataVersion: 501, schemaVersion: 7 });
    const response = createTestInsertBatchHandler(db)({ count: 50 });
    expect(response).toEqual({ committedTotal: 550 });
  });

  it('id уникальны В ПРЕДЕЛАХ ХЕНДЛЕРА и между батчами (PK bp_measurement)', () => {
    const db = fakeDb();
    const handler = createTestInsertBatchHandler(db);
    handler({ count: 50 });
    handler({ count: 50 });
    const ids = db.runParams.map((params) => params['id']);
    expect(new Set(ids).size).toBe(100);
  });

  it('строки несут колонки v1 с валидными значениями (CHECK 50–300/20–200/20–300, TASK-025)', () => {
    const db = fakeDb();
    createTestInsertBatchHandler(db)({ count: 3 });
    for (const row of db.runParams) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'arm',
          'created_at_utc',
          'dia',
          'id',
          'irregular_pulse',
          'note',
          'profile_id',
          'pulse',
          'source',
          'sys',
          'taken_at_utc',
          'tz_offset_minutes',
          'updated_at_utc',
        ].sort(),
      );
      const sys = row['sys'] as number;
      const dia = row['dia'] as number;
      expect(sys).toBeGreaterThanOrEqual(50);
      expect(sys).toBeLessThanOrEqual(300);
      expect(dia).toBeGreaterThanOrEqual(20);
      expect(dia).toBeLessThanOrEqual(200);
      expect(row['profile_id']).toBe('seed-profile-0001');
      expect(row['source']).toBe('manual');
    }
  });

  it('моменты taken_at_utc строго возрастают (порядок журнала), created/updated = моменту', () => {
    const db = fakeDb();
    createTestInsertBatchHandler(db)({ count: 10 });
    let previous = -Infinity;
    for (const row of db.runParams) {
      const takenAt = row['taken_at_utc'] as number;
      expect(takenAt).toBeGreaterThan(previous);
      previous = takenAt;
      expect(row['created_at_utc']).toBe(takenAt);
      expect(row['updated_at_utc']).toBe(takenAt);
    }
  });
});

describe('createTestDbStateHandler — снимок состояния (§8/§11)', () => {
  function stateDb(state: { total: number; dataVersion?: string; schemaVersion?: string }) {
    return {
      transaction(fn: () => unknown): () => unknown {
        return fn;
      },
      prepare(sql: string) {
        return {
          run(): unknown {
            return { changes: 0 };
          },
          get(): unknown {
            if (sql.includes('COUNT(*)')) {
              return { total: state.total };
            }
            if (sql.includes("'data_version'")) {
              return state.dataVersion === undefined ? undefined : { value: state.dataVersion };
            }
            if (sql.includes("'schema_version'")) {
              return state.schemaVersion === undefined ? undefined : { value: state.schemaVersion };
            }
            return undefined;
          },
        };
      },
    };
  }

  it('возвращает факты {count, dataVersion, schemaVersion} из meta/таблицы (§8)', () => {
    const handler = createTestDbStateHandler(
      stateDb({ total: 750, dataVersion: '751', schemaVersion: '7' }),
    );
    expect(handler({})).toEqual({ count: 750, dataVersion: 751, schemaVersion: 7 });
  });

  it('отсутствующие строки meta — честные нули (свежая/повреждённая БД)', () => {
    const handler = createTestDbStateHandler(stateDb({ total: 0 }));
    expect(handler({})).toEqual({ count: 0, dataVersion: 0, schemaVersion: 0 });
  });

  it('мусор в meta (не-число) — 0, а не NaN (форма ответа — контракт §11)', () => {
    const handler = createTestDbStateHandler(
      stateDb({ total: 5, dataVersion: 'не-число', schemaVersion: '' }),
    );
    expect(handler({})).toEqual({ count: 5, dataVersion: 0, schemaVersion: 0 });
  });
});
