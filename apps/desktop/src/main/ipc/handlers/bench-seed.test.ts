// TASK-062 §8/§9/§11/§13/§14/§19: юнит-тесты bench-сида main-стороны. Матрица:
//  - гард benchChannelsEnabled (§11/§14): без HL_BENCH=1 — false; с флагом и не
//    packaged — true; в packaged-эмуляции — false даже с флагом (двойная защита);
//  - генератор (§19): два прогона с одним seed — байт-идентичные данные (§20 AC3);
//    распределение день/вечер присутствует (§5: реалистичная форма день/вечер+шум);
//    ровно count записей; моменты строго возрастают и лежат в окне ~3 лет до якоря
//    (якорь — ПАРАМЕТР: детерминизм не зависит от настенных часов);
//    значения внутри CHECK-границ v1 (50–300/20–200/20–300, TASK-025 §8);
//  - хендлер (§9): ОДНА транзакция на весь сид, строк вставлено ровно count,
//    ответ {inserted: count} — факт вставки, а не эхо запроса.
import { describe, expect, it } from 'vitest';

import type { BenchSeedRequest } from '@hl/contracts';

import {
  benchChannelsEnabled,
  createBenchSeedHandler,
  generateSyntheticMeasurements,
  HL_BENCH_ENV,
  type SyntheticMeasurementRow,
} from './bench-seed.js';

/** Фиксированный якорь (детерминизм §20 AC3: якорь — параметр, не часы). */
const ANCHOR_MS = Date.UTC(2026, 8, 28, 12, 0, 0);
const SEED = 20260928;

describe('benchChannelsEnabled — гард регистрации bench-канала (§11/§14)', () => {
  it('без HL_BENCH=1 регистрация пропускается (§11: тест)', () => {
    expect(benchChannelsEnabled({}, false)).toBe(false);
    expect(benchChannelsEnabled({ [HL_BENCH_ENV]: '0' }, false)).toBe(false);
    expect(benchChannelsEnabled({ [HL_BENCH_ENV]: '' }, false)).toBe(false);
    expect(benchChannelsEnabled({ [HL_BENCH_ENV]: '1' }, false)).toBe(true);
  });

  it('в packaged-режиме env игнорируется — двойная защита (§14: тест-эмуляция isPackaged)', () => {
    expect(benchChannelsEnabled({ [HL_BENCH_ENV]: '1' }, true)).toBe(false);
  });
});

describe('generateSyntheticMeasurements — детерминизм и форма (§5/§19/§20 AC3)', () => {
  const rows = generateSyntheticMeasurements({ count: 10_000, seed: SEED, anchorUtcMs: ANCHOR_MS });

  it('два прогона с одним seed — байт-идентичные данные (§20 AC3)', () => {
    const second = generateSyntheticMeasurements({
      count: 10_000,
      seed: SEED,
      anchorUtcMs: ANCHOR_MS,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(rows));
  });

  it('разные seed — разные данные', () => {
    const other = generateSyntheticMeasurements({
      count: 10_000,
      seed: SEED + 1,
      anchorUtcMs: ANCHOR_MS,
    });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(rows));
  });

  it('ровно count записей, id уникальны', () => {
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => row.id)).size).toBe(10_000);
  });

  it('распределение день/вечер присутствует (§19: обе части ≥30% — форма 45/45/10)', () => {
    const morning = rows.filter((row) => row.part === 'morning').length;
    const evening = rows.filter((row) => row.part === 'evening').length;
    expect(morning).toBeGreaterThanOrEqual(3000);
    expect(evening).toBeGreaterThanOrEqual(3000);
  });

  it('моменты строго возрастают, окно ~3 лет до якоря, час согласован с частью', () => {
    let previous = -Infinity;
    for (const row of rows) {
      expect(row.takenAtUtc).toBeGreaterThan(previous);
      previous = row.takenAtUtc;
      expect(row.takenAtUtc).toBeLessThanOrEqual(ANCHOR_MS);
      const hourUtc = new Date(row.takenAtUtc).getUTCHours();
      // Разруливание ничьих (+1 мс, §13 bench-seed) может унести момент на секунду
      // в следующий час — допустимый час части: окно генератора ∪ {верх+1}.
      if (row.part === 'morning') {
        expect(hourUtc).toBeGreaterThanOrEqual(4);
        expect(hourUtc).toBeLessThanOrEqual(9);
      } else if (row.part === 'evening') {
        expect(hourUtc).toBeGreaterThanOrEqual(14);
        expect(hourUtc).toBeLessThanOrEqual(19);
      }
    }
    const spanDays = (ANCHOR_MS - rows[0]!.takenAtUtc) / 86_400_000;
    expect(spanDays).toBeGreaterThan(1090);
    expect(spanDays).toBeLessThanOrEqual(1100);
  });

  it('значения внутри CHECK-границ v1 (TASK-025 §8: 50–300 / 20–200 / 20–300)', () => {
    for (const row of rows) {
      expect(row.sys).toBeGreaterThanOrEqual(50);
      expect(row.sys).toBeLessThanOrEqual(300);
      expect(row.dia).toBeGreaterThanOrEqual(20);
      expect(row.dia).toBeLessThanOrEqual(200);
      if (row.pulse !== null) {
        expect(row.pulse).toBeGreaterThanOrEqual(20);
        expect(row.pulse).toBeLessThanOrEqual(300);
      }
      expect(['left', 'right']).toContain(row.arm);
      expect(row.source).toBe('manual');
      expect(row.profileId).toBe('seed-profile-0001');
    }
  });

  it('шум присутствует: sys не вырожден в константу (§5 «+шум»)', () => {
    const sysValues = new Set(rows.slice(0, 500).map((row) => row.sys));
    expect(sysValues.size).toBeGreaterThan(10);
  });
});

describe('createBenchSeedHandler — транзакционная вставка (§8/§9)', () => {
  /**
   * Fake-БД в форме better-sqlite3 (transaction + prepare.run): механика §19.
   * ЧЕСТНЫЙ контракт better-sqlite3: transaction(fn) ВОЗВРАЩАЕТ транзакционную
   * функцию, счётчик транзакций растёт при её ВЫЗОВЕ (а не при создании) —
   * иначе тест маскирует промах «создал транзакцию, не вызвал» (пойман пробой
   * bench на живой БД, §24).
   */
  function fakeDb() {
    const runParams: Record<string, unknown>[] = [];
    const preparedSql: string[] = [];
    let transactions = 0;
    return {
      runParams,
      preparedSql,
      transactions: () => transactions,
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
          run(params: Record<string, unknown>): unknown {
            runParams.push(params);
            return undefined;
          },
        };
      },
    };
  }

  it('готовит INSERT строки bp_measurement v1 (TASK-025 §8: схема без изменений)', () => {
    const db = fakeDb();
    createBenchSeedHandler(db, { seed: SEED, anchorUtcMs: ANCHOR_MS })({ count: 1 });
    expect(db.preparedSql).toHaveLength(1);
    expect(db.preparedSql[0]).toContain('INSERT INTO bp_measurement');
    expect(db.preparedSql[0]).toContain('taken_at_utc');
  });

  it('вставляет count строк ОДНОЙ транзакцией, ответ — факт вставки {inserted: count}', () => {
    const db = fakeDb();
    const handler = createBenchSeedHandler(db, { seed: SEED, anchorUtcMs: ANCHOR_MS });
    const request: BenchSeedRequest = { count: 100 };
    const response = handler(request);
    expect(response).toEqual({ inserted: 100 });
    expect(db.transactions()).toBe(1);
    expect(db.runParams).toHaveLength(100);
    // Каждая строка — 13 именованных параметров INSERT v1 (id … updated_at_utc).
    expect(Object.keys(db.runParams[0] as object)).toHaveLength(13);
  });

  it('count 0 — валидный пустой сид: транзакция без строк, {inserted: 0}', () => {
    const db = fakeDb();
    const handler = createBenchSeedHandler(db, { seed: SEED, anchorUtcMs: ANCHOR_MS });
    expect(handler({ count: 0 })).toEqual({ inserted: 0 });
    expect(db.transactions()).toBe(1);
    expect(db.runParams).toHaveLength(0);
  });

  it('строки идут в порядке генератора и несут колонки v1 (id, profile_id, taken_at_utc…)', () => {
    const db = fakeDb();
    const handler = createBenchSeedHandler(db, { seed: SEED, anchorUtcMs: ANCHOR_MS });
    const rows = generateSyntheticMeasurements({
      count: 3,
      seed: SEED,
      anchorUtcMs: ANCHOR_MS,
    });
    handler({ count: 3 });
    const expected = rows.map((row: SyntheticMeasurementRow) => ({
      id: row.id,
      profile_id: row.profileId,
      taken_at_utc: row.takenAtUtc,
      tz_offset_minutes: row.tzOffsetMinutes,
      sys: row.sys,
      dia: row.dia,
      pulse: row.pulse,
      irregular_pulse: row.irregularPulse ? 1 : 0,
      arm: row.arm,
      note: row.note,
      source: row.source,
      created_at_utc: row.createdAtUtc,
      updated_at_utc: row.updatedAtUtc,
    }));
    expect(db.runParams).toEqual(expected);
  });
});
