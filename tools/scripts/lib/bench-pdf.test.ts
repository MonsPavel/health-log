// TASK-069 §13/§19/§20: юнит-тесты pdf-конфига и отчёта bench PDF — чистые функции
// без ФС (прецедент bench-report.test.ts TASK-062: либа отделена от скрипта ради
// юнит-тестов). Матрица:
//  - гейт-функция порога 30 с на ЗНАЧЕНИЯХ §19: 29 999 → ok, 30 001 → fail
//    (функция — общая с 062 evaluateBenchGate, здесь проверяется с pdf-порогом);
//  - конфиг генерации/прогонов (§5): count 5000, повторов 3, порог 30 000 мс;
//  - отчёт (§20 AC4): медиана/мин/макс прогонов, размер PDF, count записей;
//    пробитый порог — gateOk:false и exitCode 1 (§20 AC2 — механика подстановки
//    порога 1 мс в smoke использует ту же функцию).
import { describe, expect, it } from 'vitest';

import { evaluateBenchGate } from './bench-report.js';
import {
  BENCH_PDF_COUNT_DEFAULT,
  BENCH_PDF_GATE_MS,
  BENCH_PDF_RUNS_DEFAULT,
  buildPdfBenchJson,
  buildPdfBenchText,
} from './bench-pdf.js';

/** Фикстура входа (§19): три прогона + размеры файлов + машина-контекст. */
function fixtureInput() {
  return {
    count: 5_000,
    runsMs: [21_000, 19_500, 20_250],
    fileRunsBytes: [1_200_100, 1_200_000, 1_200_050],
    thresholdMs: BENCH_PDF_GATE_MS,
    machine: { cpu: 'Test CPU 8-Core', platform: 'win32', nodeVersion: '20.0.0' },
    dateUtc: '2026-09-29T12:00:00.000Z',
  };
}

describe('конфиг bench-pdf (§5/§13)', () => {
  it('профиль: 5000 записей, 3 прогона (медиана), гейт 30 000 мс (NFR-4)', () => {
    expect(BENCH_PDF_COUNT_DEFAULT).toBe(5_000);
    expect(BENCH_PDF_RUNS_DEFAULT).toBe(3);
    expect(BENCH_PDF_GATE_MS).toBe(30_000);
  });
});

describe('гейт 30 с на значениях §19 (функция общая с 062)', () => {
  it('29 999 мс → ok; 30 000 мс → ok (≤ включает равенство, прецедент 062)', () => {
    expect(evaluateBenchGate(29_999, BENCH_PDF_GATE_MS)).toBe(true);
    expect(evaluateBenchGate(30_000, BENCH_PDF_GATE_MS)).toBe(true);
  });

  it('30 001 мс → fail', () => {
    expect(evaluateBenchGate(30_001, BENCH_PDF_GATE_MS)).toBe(false);
  });
});

describe('buildPdfBenchJson — машинная фактура отчёта (§20 AC4)', () => {
  const json = buildPdfBenchJson(fixtureInput());

  it('медиана/мин/макс прогонов; медиана — не минимум и не максимум (§13 062)', () => {
    expect(json.timings).toEqual({ medianMs: 20_250, minMs: 19_500, maxMs: 21_000 });
  });

  it('размер PDF: медиана/мин/макс по прогонам', () => {
    expect(json.file).toEqual({
      medianBytes: 1_200_050,
      minBytes: 1_200_000,
      maxBytes: 1_200_100,
    });
  });

  it('count записей, период, порог и машина-контекст перенесены как есть', () => {
    expect(json.task).toBe('TASK-069');
    expect(json.count).toBe(5_000);
    expect(json.period).toBe('all');
    expect(json.thresholdMs).toBe(30_000);
    expect(json.runsMs).toEqual([21_000, 19_500, 20_250]);
    expect(json.fileRunsBytes).toEqual([1_200_100, 1_200_000, 1_200_050]);
    expect(json.machine.cpu).toBe('Test CPU 8-Core');
    expect(json.dateUtc).toBe('2026-09-29T12:00:00.000Z');
  });

  it('медиана ≤ порога → gateOk:true, exitCode 0', () => {
    expect(json.gateOk).toBe(true);
    expect(json.exitCode).toBe(0);
  });

  it('медиана сверх порога → gateOk:false, exitCode 1 (механика §20 AC2)', () => {
    const failing = buildPdfBenchJson({ ...fixtureInput(), runsMs: [30_100, 30_050, 31_000] });
    expect(failing.timings.medianMs).toBe(30_100);
    expect(failing.gateOk).toBe(false);
    expect(failing.exitCode).toBe(1);
  });

  it('пустые прогоны — честная ошибка расчёта (медиана неопределима)', () => {
    expect(() => buildPdfBenchJson({ ...fixtureInput(), runsMs: [] })).toThrow();
  });
});

describe('buildPdfBenchText — человекочитаемый отчёт (§16: dev-инструмент, английский)', () => {
  const text = buildPdfBenchText(buildPdfBenchJson(fixtureInput()));

  it('содержит медиану/мин/макс, порог, размер PDF, count и вердикт (§20 AC4)', () => {
    expect(text).toContain('TASK-069');
    expect(text).toContain('median: 20250');
    expect(text).toContain('min: 19500');
    expect(text).toContain('max: 21000');
    expect(text).toContain('threshold 30000');
    expect(text).toContain('1200050');
    expect(text).toContain('records: 5000');
    expect(text).toContain('PASS');
  });

  it('падение — строка FAIL с разметкой гейта', () => {
    const failing = buildPdfBenchText(
      buildPdfBenchJson({ ...fixtureInput(), runsMs: [30_100, 30_050, 31_000] }),
    );
    expect(failing).toContain('FAIL');
    expect(failing).toContain('median gate');
  });
});
