// TASK-111 §13/§19: юнит-тесты конфига и отчёта bench экспорта CSV — чистые функции
// без ФС (прецедент bench-pdf.test.ts TASK-069). Матрица:
//  - конфиг (§5): 50 000 записей (NFR-9), 3 прогона (медиана), гейт 60 000 мс
//    (NFR-4 экспорт 50k <60 с);
//  - гейт-функция порога на ЗНАЧЕНИЯХ §19: 59 999 → ok, 60 000 → ok (≤),
//    60 001 → fail (функция — общая с 062 evaluateBenchGate);
//  - отчёт: медиана/мин/макс прогонов, размер CSV по прогонам, count; пробитый
//    порог — gateOk:false и exitCode 1.
import { describe, expect, it } from 'vitest';

import { evaluateBenchGate } from './bench-report.js';
import {
  BENCH_EXPORT_COUNT_DEFAULT,
  BENCH_EXPORT_GATE_MS,
  BENCH_EXPORT_RUNS_DEFAULT,
  buildExportBenchJson,
  buildExportBenchText,
} from './bench-export.js';

/** Фикстура входа (§19): три прогона + размеры файлов + машина-контекст. */
function fixtureInput() {
  return {
    count: 50_000,
    runsMs: [9_200, 8_100, 8_650],
    fileRunsBytes: [6_100_200, 6_100_000, 6_100_100],
    thresholdMs: BENCH_EXPORT_GATE_MS,
    machine: { cpu: 'Test CPU 8-Core', platform: 'win32', nodeVersion: '20.0.0' },
    dateUtc: '2026-10-03T12:00:00.000Z',
  };
}

describe('конфиг bench-export (§5/§13)', () => {
  it('профиль: 50 000 записей (NFR-9), 3 прогона (медиана), гейт 60 000 мс (NFR-4)', () => {
    expect(BENCH_EXPORT_COUNT_DEFAULT).toBe(50_000);
    expect(BENCH_EXPORT_RUNS_DEFAULT).toBe(3);
    expect(BENCH_EXPORT_GATE_MS).toBe(60_000);
  });
});

describe('гейт 60 с на значениях §19 (функция общая с 062)', () => {
  it('59 999 мс → ok; 60 000 мс → ok (≤ включает равенство, прецедент 062)', () => {
    expect(evaluateBenchGate(59_999, BENCH_EXPORT_GATE_MS)).toBe(true);
    expect(evaluateBenchGate(60_000, BENCH_EXPORT_GATE_MS)).toBe(true);
  });

  it('60 001 мс → fail', () => {
    expect(evaluateBenchGate(60_001, BENCH_EXPORT_GATE_MS)).toBe(false);
  });
});

describe('buildExportBenchJson — машинная фактура отчёта (§20 AC4)', () => {
  const json = buildExportBenchJson(fixtureInput());

  it('медиана/мин/макс прогонов; медиана — не минимум и не максимум (§13 062)', () => {
    expect(json.timings).toEqual({ medianMs: 8_650, minMs: 8_100, maxMs: 9_200 });
  });

  it('размер CSV: медиана/мин/макс по прогонам', () => {
    expect(json.file).toEqual({
      medianBytes: 6_100_100,
      minBytes: 6_100_000,
      maxBytes: 6_100_200,
    });
  });

  it('count записей, период, порог и машина-контекст перенесены как есть', () => {
    expect(json.task).toBe('TASK-111');
    expect(json.count).toBe(50_000);
    expect(json.period).toBe('all');
    expect(json.thresholdMs).toBe(60_000);
    expect(json.runsMs).toEqual([9_200, 8_100, 8_650]);
    expect(json.fileRunsBytes).toEqual([6_100_200, 6_100_000, 6_100_100]);
    expect(json.machine.cpu).toBe('Test CPU 8-Core');
    expect(json.dateUtc).toBe('2026-10-03T12:00:00.000Z');
  });

  it('медиана ≤ порога → gateOk:true, exitCode 0', () => {
    expect(json.gateOk).toBe(true);
    expect(json.exitCode).toBe(0);
  });

  it('медиана сверх порога → gateOk:false, exitCode 1', () => {
    const failing = buildExportBenchJson({ ...fixtureInput(), runsMs: [60_100, 60_050, 61_000] });
    expect(failing.timings.medianMs).toBe(60_100);
    expect(failing.gateOk).toBe(false);
    expect(failing.exitCode).toBe(1);
  });

  it('пустые прогоны — честная ошибка расчёта (медиана неопределима)', () => {
    expect(() => buildExportBenchJson({ ...fixtureInput(), runsMs: [] })).toThrow();
  });
});

describe('buildExportBenchText — человекочитаемый отчёт (§16: dev-инструмент, английский)', () => {
  const text = buildExportBenchText(buildExportBenchJson(fixtureInput()));

  it('содержит медиану/мин/макс, порог, размер CSV, count и вердикт', () => {
    expect(text).toContain('TASK-111');
    expect(text).toContain('median: 8650');
    expect(text).toContain('min: 8100');
    expect(text).toContain('max: 9200');
    expect(text).toContain('threshold 60000');
    expect(text).toContain('6100100');
    expect(text).toContain('records: 50000');
    expect(text).toContain('PASS');
  });

  it('падение — строка FAIL с разметкой гейта', () => {
    const failing = buildExportBenchText(
      buildExportBenchJson({ ...fixtureInput(), runsMs: [60_100, 60_050, 61_000] }),
    );
    expect(failing).toContain('FAIL');
    expect(failing).toContain('median gate');
  });
});
