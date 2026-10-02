// TASK-102 §19/§20 AC2: юнит-тесты вердикт-функций крэш-теста — таблица комбинаций
// ack/found/dv/schema → PASS/FAIL (§2: инварианты «подтверждённое = целое», «схема
// цела», «data_version согласован»; §8: точная форма — батч атомарен, поэтому
// count == ack (батч откатился/не долетел) ИЛИ ack + batchSize (долетел, ack
// потерян); частичный батч НЕВОЗМОЖЕН и ловится как PARTIAL_BATCH — именно его
// даёт dev-демо авто-коммита §20-3). Плюс: детерминизм PRNG (§13) и сборка отчёта
// (§18: per-iteration ack/found/dv/verdict, итог PASS/FAIL, exit-код).
import { describe, expect, it } from 'vitest';

import {
  buildCrashReportJson,
  buildCrashReportText,
  CRASH_DATA_VERSION_BASE,
  crashExitCode,
  evaluateCrashIteration,
  mulberry32,
  randomIntBetween,
  type CrashIterationInput,
} from './crash-report.js';

/** Базовый здоровый ввод: ack 500 (калибровка 10×50), килл без батча в полёте. */
function healthyInput(overrides: Partial<CrashIterationInput> = {}): CrashIterationInput {
  return {
    ack: 500,
    found: 500,
    dataVersion: 500 + CRASH_DATA_VERSION_BASE,
    schemaVersion: 7,
    expectedSchemaVersion: 7,
    batchSize: 50,
    batchInFlight: false,
    ...overrides,
  };
}

describe('evaluateCrashIteration — таблица комбинаций ack/found/dv (§19, §20 AC2)', () => {
  it('PASS: found == ack, dv == 1 + found, схема актуальна (килл в паузе, без полёта)', () => {
    const verdict = evaluateCrashIteration(healthyInput());
    expect(verdict).toEqual({ pass: true, violations: [] });
  });

  it('PASS: found == ack при батче в полёте — недо-батч ЦЕЛИКОМ откатился (§8)', () => {
    const verdict = evaluateCrashIteration(healthyInput({ batchInFlight: true }));
    expect(verdict).toEqual({ pass: true, violations: [] });
  });

  it('PASS: found == ack + 50 при батче в полёте — транзакция дошла до диска, ack потерян', () => {
    const verdict = evaluateCrashIteration(
      healthyInput({ found: 550, dataVersion: 551, batchInFlight: true }),
    );
    expect(verdict).toEqual({ pass: true, violations: [] });
  });

  it('FAIL LOST_ACK: found < ack — ПОТЕРЯ ПОДТВЕРЖДЁННОГО (главный страх R-4, NFR-3)', () => {
    const verdict = evaluateCrashIteration(healthyInput({ found: 470, dataVersion: 471 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['LOST_ACK']);
  });

  it('FAIL PARTIAL_BATCH: ack < found < ack + 50 — атомарность батча сломана (демо §20-3)', () => {
    const verdict = evaluateCrashIteration(
      healthyInput({ found: 520, dataVersion: 521, batchInFlight: true }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['PARTIAL_BATCH']);
  });

  it('FAIL PARTIAL_BATCH: частичный батч ловится и без флага полёта (found ушёл вперёд ack)', () => {
    const verdict = evaluateCrashIteration(healthyInput({ found: 530, dataVersion: 531 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['PARTIAL_BATCH']);
  });

  it('FAIL UNEXPECTED_TAIL: found > ack + batchSize — хвост вне модели (чужая запись)', () => {
    const verdict = evaluateCrashIteration(
      healthyInput({ found: 601, dataVersion: 602, batchInFlight: true }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['UNEXPECTED_TAIL']);
  });

  it('FAIL UNEXPECTED_TAIL: found == ack + batchSize БЕЗ батча в полёте — хвост неоткуда взять', () => {
    const verdict = evaluateCrashIteration(healthyInput({ found: 550, dataVersion: 551 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['UNEXPECTED_TAIL']);
  });

  it('FAIL DATA_VERSION_MISMATCH: dv не сходится с формулой 1 + count (§8)', () => {
    const verdict = evaluateCrashIteration(healthyInput({ dataVersion: 999 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['DATA_VERSION_MISMATCH']);
  });

  it('FAIL SCHEMA_MISMATCH: schema_version отличается от калибровочной (схема не цела, §2)', () => {
    const verdict = evaluateCrashIteration(healthyInput({ schemaVersion: 6 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual(['SCHEMA_MISMATCH']);
  });

  it('FAIL: несколько нарушений копятся в один список (потеря + мусорный dv + схема)', () => {
    const verdict = evaluateCrashIteration(
      healthyInput({ found: 100, dataVersion: 3, schemaVersion: 5 }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual([
      'LOST_ACK',
      'DATA_VERSION_MISMATCH',
      'SCHEMA_MISMATCH',
    ]);
  });

  it('PASS при другом размере батча: found == ack + batchSize учитывает batchSize ввода', () => {
    const verdict = evaluateCrashIteration(
      healthyInput({
        ack: 10_000,
        found: 15_000,
        dataVersion: 15_001,
        batchSize: 5000,
        batchInFlight: true,
      }),
    );
    expect(verdict).toEqual({ pass: true, violations: [] });
  });
});

describe('mulberry32/randomIntBetween — детерминизм сценария убийств (§13)', () => {
  it('одинаковый seed — одинаковая последовательность; разный — другая', () => {
    const a = mulberry32(20261002);
    const b = mulberry32(20261002);
    const c = mulberry32(20261003);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    const seqC = Array.from({ length: 10 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('randomIntBetween — целые в границах [min, max] включительно', () => {
    const next = mulberry32(42);
    for (let i = 0; i < 1000; i += 1) {
      const value = randomIntBetween(next, 50, 500);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(50);
      expect(value).toBeLessThanOrEqual(500);
    }
  });

  it('одинаковый seed — одинаковый план киллов (регресс-сравнение прогонов, §13)', () => {
    const plan = (seed: number): number[] => {
      const next = mulberry32(seed);
      return Array.from({ length: 5 }, () => randomIntBetween(next, 50, 500));
    };
    expect(plan(7)).toEqual(plan(7));
  });
});

describe('buildCrashReportJson/buildCrashReportText — отчёт (§18)', () => {
  const records = [
    {
      index: 1,
      ack: 500,
      found: 500,
      dataVersion: 501,
      schemaVersion: 7,
      batchInFlight: false,
      killMode: 'idle' as const,
      durationMs: 8123,
      verdict: { pass: true, violations: [] },
    },
    {
      index: 2,
      ack: 550,
      found: 600,
      dataVersion: 601,
      schemaVersion: 7,
      batchInFlight: true,
      killMode: 'in-flight' as const,
      durationMs: 9456,
      verdict: { pass: true, violations: [] },
    },
  ];

  it('json: итог PASS, exit 0, per-iteration (ack, found, dv, verdict) на месте (§18)', () => {
    const json = buildCrashReportJson({
      seed: 20261002,
      batchSize: 50,
      calibrationBatches: 10,
      records,
      startedAtUtc: Date.UTC(2026, 9, 2, 12, 0, 0),
      durationMs: 17_579,
      machine: { platform: 'win32', nodeVersion: 'v24.13.0' },
    });
    expect(json.pass).toBe(true);
    expect(json.exitCode).toBe(0);
    expect(json.iterations).toHaveLength(2);
    expect(json.iterations[0]).toMatchObject({ ack: 500, found: 500, dataVersion: 501 });
    expect(json.verdict).toBe('PASS');
  });

  it('json: нарушение у одной итерации — итог FAIL, exit 1 (§18/§20 AC1)', () => {
    const failed = [
      ...records.slice(0, 1),
      {
        ...records[1]!,
        verdict: { pass: false, violations: ['LOST_ACK' as const] },
      },
    ];
    const json = buildCrashReportJson({
      seed: 20261002,
      batchSize: 50,
      calibrationBatches: 10,
      records: failed,
      startedAtUtc: Date.UTC(2026, 9, 2, 12, 0, 0),
      durationMs: 17_579,
    });
    expect(json.pass).toBe(false);
    expect(json.exitCode).toBe(1);
    expect(json.verdict).toBe('FAIL');
  });

  it('текст: строка на итерацию (ack/found/dv/verdict) + итог PASS/FAIL (§18: файл + консоль)', () => {
    const json = buildCrashReportJson({
      seed: 20261002,
      batchSize: 50,
      calibrationBatches: 10,
      records,
      startedAtUtc: Date.UTC(2026, 9, 2, 12, 0, 0),
      durationMs: 17_579,
      machine: { platform: 'win32' },
    });
    const text = buildCrashReportText(json);
    expect(text).toContain('NFR-3');
    expect(text).toContain('seed=20261002');
    expect(text).toContain('#1');
    expect(text).toContain('ack=500');
    expect(text).toContain('found=500');
    expect(text).toContain('dv=501');
    expect(text).toContain('PASS');
    expect(text).toContain('#2');
    expect(text).toContain('found=600');
    expect(text).toContain('ИТОГ: PASS');
    expect(text).not.toContain('ИТОГ: FAIL');
  });

  it('crashExitCode: все PASS → 0; хоть один FAIL → 1', () => {
    expect(crashExitCode(records.map((record) => record.verdict))).toBe(0);
    expect(crashExitCode([...records.map((r) => r.verdict), { pass: false, violations: [] }])).toBe(
      1,
    );
  });
});
