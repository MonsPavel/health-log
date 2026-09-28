// TASK-062 §13/§19: юнит-тесты отчёта bench — чистые функции без ФС. Матрица:
//  - медиана 3 прогонов (не минимум — §13: «честность замера»); чётный набор —
//    среднее двух средин; порядок входа не важен;
//  - гейт-логика порогов (§5): ≤ проходит, ровно порог — проходит (гейты
//    «A ≤200 мс, B ≤800 мс»), сверх — нет; 0-порог не проходит ничего >0;
//  - форматтеры: текст содержит медианы, гейты, машину-контекст (строка-класс
//    CPU — не гарантия, §13) и вердикт; JSON — та же фактура + exitCode.
import { describe, expect, it } from 'vitest';

import {
  BENCH_GATE_CHANNEL_MS,
  BENCH_GATE_RENDER_MS,
  buildBenchJson,
  buildBenchText,
  evaluateBenchGate,
  medianOf,
} from './bench-report.js';

/** Фикстура входа (§19): два прогон-набора + машина-контекст. */
function fixtureInput() {
  return {
    count: 10_000,
    period: 'all',
    mode: 'daily',
    channelRunsMs: [180, 150, 190],
    renderRunsMs: [700, 500, 600],
    thresholds: { channelMs: BENCH_GATE_CHANNEL_MS, renderMs: BENCH_GATE_RENDER_MS },
    machine: { cpu: 'Test CPU 8-Core', platform: 'win32', nodeVersion: '20.0.0' },
    dateUtc: '2026-09-28T12:00:00.000Z',
  };
}

describe('medianOf — медиана прогонов (§13: не минимум)', () => {
  it('нечётный набор — срединное значение, не минимум и не максимум', () => {
    expect(medianOf([180, 150, 190])).toBe(180);
  });

  it('чётный набор — среднее двух средин', () => {
    expect(medianOf([100, 200, 300, 400])).toBe(250);
  });

  it('порядок входа не важен, одиночное значение — оно само', () => {
    expect(medianOf([190, 150, 180])).toBe(180);
    expect(medianOf([42])).toBe(42);
  });
});

describe('evaluateBenchGate — пороги §5 (A ≤200, B ≤800)', () => {
  it('строго меньше — проходит, ровно порог — проходит (≤)', () => {
    expect(evaluateBenchGate(199.9, 200)).toBe(true);
    expect(evaluateBenchGate(200, 200)).toBe(true);
    expect(evaluateBenchGate(800, 800)).toBe(true);
  });

  it('строго больше — не проходит', () => {
    expect(evaluateBenchGate(200.1, 200)).toBe(false);
    expect(evaluateBenchGate(801, 800)).toBe(false);
  });

  it('нулевой порог не проходит ничего больше нуля (искусственное замедление — exit 1, §20 AC2)', () => {
    expect(evaluateBenchGate(0, 0)).toBe(true);
    expect(evaluateBenchGate(0.5, 0)).toBe(false);
  });
});

describe('buildBenchJson — машинная фактура отчёта (§5 шаг 5)', () => {
  const json = buildBenchJson(fixtureInput());

  it('медианы: канал 180, рендер 600, сумма 780', () => {
    expect(json.medians).toEqual({ channelMs: 180, renderMs: 600, totalMs: 780 });
  });

  it('гейты: 180≤200 и 600≤800 → ok, exitCode 0', () => {
    expect(json.gates).toEqual({ channelOk: true, renderOk: true, ok: true });
    expect(json.exitCode).toBe(0);
  });

  it('переносит прогоны, пороги, машину и контекст прогона как есть', () => {
    expect(json.channelRunsMs).toEqual([180, 150, 190]);
    expect(json.renderRunsMs).toEqual([700, 500, 600]);
    expect(json.thresholds).toEqual({ channelMs: 200, renderMs: 800 });
    expect(json.machine.cpu).toBe('Test CPU 8-Core');
    expect(json.count).toBe(10_000);
    expect(json.mode).toBe('daily');
    expect(json.dateUtc).toBe('2026-09-28T12:00:00.000Z');
  });

  it('пробитый гейт — ok:false и exitCode 1 (§20 AC2)', () => {
    const failing = buildBenchJson({
      ...fixtureInput(),
      channelRunsMs: [210, 220, 230],
    });
    expect(failing.gates).toEqual({ channelOk: false, renderOk: true, ok: false });
    expect(failing.exitCode).toBe(1);
  });
});

describe('buildBenchText — человекочитаемый отчёт (§16: dev-инструмент, английский)', () => {
  const text = buildBenchText(buildBenchJson(fixtureInput()));

  it('содержит медианы, пороги, машину и вердикт', () => {
    expect(text).toContain('channel median: 180');
    expect(text).toContain('render median: 600');
    expect(text).toContain('total: 780');
    expect(text).toContain('threshold 200');
    expect(text).toContain('threshold 800');
    expect(text).toContain('Test CPU 8-Core');
    expect(text).toContain('PASS');
    expect(text).toContain('records: 10000');
  });

  it('падение — строка FAIL с разметкой гейта рендера', () => {
    const failing = buildBenchText(
      buildBenchJson({ ...fixtureInput(), renderRunsMs: [900, 950, 1000] }),
    );
    expect(failing).toContain('FAIL');
    expect(failing).toContain('render gate');
  });
});
