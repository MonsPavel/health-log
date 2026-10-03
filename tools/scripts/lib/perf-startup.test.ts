// TASK-111 §13/§19: юнит-тесты конфига и отчёта bench старта — чистые функции без
// ФС/процессов (прецедент bench-pdf.test.ts TASK-069: либа отделена от скрипта ради
// юнит-тестов). Матрица:
//  - конфиг (§5): 5 прогонов (медиана), гейт 3000 мс (NFR-4 холодный старт ≤3 с);
//  - гейт-функция порога на ЗНАЧЕНИЯХ §19: 2999 → ok, 3000 → ok (≤), 3001 → fail
//    (функция — общая с 062 evaluateBenchGate, здесь проверяется со старт-порогом);
//  - отчёт: медиана/мин/макс прогонов, имя exe, машина-контекст; пробитый порог —
//    gateOk:false и exitCode 1.
import { describe, expect, it } from 'vitest';

import { evaluateBenchGate } from './bench-report.js';
import {
  STARTUP_GATE_MS,
  STARTUP_RUNS_DEFAULT,
  buildStartupBenchJson,
  buildStartupBenchText,
} from './perf-startup.js';

/** Фикстура входа (§19): пять прогонов (нечётная медиана) + машина-контекст. */
function fixtureInput() {
  return {
    exe: 'Health Log.exe',
    runsMs: [2450, 2320, 2395, 2600, 2410],
    thresholdMs: STARTUP_GATE_MS,
    machine: { cpu: 'Test CPU 8-Core', platform: 'win32', nodeVersion: '20.0.0' },
    dateUtc: '2026-10-03T12:00:00.000Z',
  };
}

describe('конфиг perf-startup (§5/§13)', () => {
  it('5 прогонов (медиана), гейт 3000 мс (NFR-4 холодный старт)', () => {
    expect(STARTUP_RUNS_DEFAULT).toBe(5);
    expect(STARTUP_GATE_MS).toBe(3_000);
  });
});

describe('гейт 3 с на значениях §19 (функция общая с 062)', () => {
  it('2999 мс → ok; 3000 мс → ok (≤ включает равенство, прецедент 062)', () => {
    expect(evaluateBenchGate(2_999, STARTUP_GATE_MS)).toBe(true);
    expect(evaluateBenchGate(3_000, STARTUP_GATE_MS)).toBe(true);
  });

  it('3001 мс → fail', () => {
    expect(evaluateBenchGate(3_001, STARTUP_GATE_MS)).toBe(false);
  });
});

describe('buildStartupBenchJson — машинная фактура отчёта (§5 шаг старт)', () => {
  const json = buildStartupBenchJson(fixtureInput());

  it('медиана/мин/макс прогонов; медиана — не минимум и не максимум (§13 062)', () => {
    expect(json.timings).toEqual({ medianMs: 2_410, minMs: 2_320, maxMs: 2_600 });
  });

  it('имя exe, порог, прогоны и машина-контекст перенесены как есть', () => {
    expect(json.task).toBe('TASK-111');
    expect(json.exe).toBe('Health Log.exe');
    expect(json.thresholdMs).toBe(3_000);
    expect(json.runsMs).toEqual([2_450, 2_320, 2_395, 2_600, 2_410]);
    expect(json.machine.cpu).toBe('Test CPU 8-Core');
    expect(json.dateUtc).toBe('2026-10-03T12:00:00.000Z');
  });

  it('медиана ≤ порога → gateOk:true, exitCode 0', () => {
    expect(json.gateOk).toBe(true);
    expect(json.exitCode).toBe(0);
  });

  it('медиана сверх порога → gateOk:false, exitCode 1', () => {
    const failing = buildStartupBenchJson({
      ...fixtureInput(),
      runsMs: [3_100, 3_050, 3_200, 2_900, 3_150],
    });
    expect(failing.timings.medianMs).toBe(3_100);
    expect(failing.gateOk).toBe(false);
    expect(failing.exitCode).toBe(1);
  });

  it('пустые прогоны — честная ошибка расчёта (медиана неопределима)', () => {
    expect(() => buildStartupBenchJson({ ...fixtureInput(), runsMs: [] })).toThrow();
  });
});

describe('buildStartupBenchText — человекочитаемый отчёт (§16: dev-инструмент, английский)', () => {
  const text = buildStartupBenchText(buildStartupBenchJson(fixtureInput()));

  it('содержит медиану/мин/макс, порог, имя exe и вердикт', () => {
    expect(text).toContain('TASK-111');
    expect(text).toContain('median: 2410');
    expect(text).toContain('min: 2320');
    expect(text).toContain('max: 2600');
    expect(text).toContain('threshold 3000');
    expect(text).toContain('Health Log.exe');
    expect(text).toContain('PASS');
  });

  it('падение — строка FAIL с разметкой гейта', () => {
    const failing = buildStartupBenchText(
      buildStartupBenchJson({
        ...fixtureInput(),
        runsMs: [3_100, 3_050, 3_200, 2_900, 3_150],
      }),
    );
    expect(failing).toContain('FAIL');
    expect(failing).toContain('median gate');
  });
});
