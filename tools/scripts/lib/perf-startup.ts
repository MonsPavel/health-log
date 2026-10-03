/**
 * TASK-111 §13: конфиг и отчёт bench старта — чистые функции без ФС/процессов
 * (прецедент bench-pdf.ts TASK-069: либа отделена от perf-startup.mjs ради
 * юнит-тестов). Медианы/гейт — функции РЕЮЗИРУЮТСЯ из bench-report.ts (§6 062:
 * «общие») — здесь только старт-конфиг (прогоны/порог §5/§13) и сборка отчёта.
 *
 * Порог гейта — из §2/§13 задачи: packaged холодный старт до первого осмысленного
 * кадра ≤3 с (NFR-4, железо A); его изменение = ревизия NFR-4. Отчёт — английский
 * (§16: dev-инструмент, прецедент size-audit/bench-report).
 */
import { evaluateBenchGate, medianOf, type BenchMachineContext } from './bench-report.js';

/** Повторов замера (§5: «старт packaged ×5 медиана»). */
export const STARTUP_RUNS_DEFAULT = 5;

/** Порог гейта холодного старта, мс (§2/§13: NFR-4 — ≤3 с). */
export const STARTUP_GATE_MS = 3_000;

/** Вход отчёта: контекст прогона + прогоны-замеры (точки ввода тестов). */
export interface StartupBenchReportInput {
  /** Имя замеряемого исполняемого файла (basename — для отчёта, §13 машина-контекст). */
  readonly exe: string;
  /** Прогоны wall-time «запуск процесса → первый осмысленный кадр», мс. */
  readonly runsMs: readonly number[];
  /** Порог гейта (по умолчанию §13; ручной прогон может ужесточать — §20 AC2 062). */
  readonly thresholdMs: number;
  readonly machine: BenchMachineContext;
  /** Момент прогона (ISO UTC) — имя файла отчёта и факт для истории bench (§23 062). */
  readonly dateUtc: string;
}

/** Тайминги прогонов (§20 AC4 069: медиана/мин/макс), мс. */
export interface StartupBenchTimings {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** Форма JSON-отчёта (§18 062: файл tools/bench-results/<date>.json, в .gitignore). */
export interface StartupBenchReportJson {
  readonly task: 'TASK-111';
  readonly kind: 'startup';
  readonly dateUtc: string;
  readonly exe: string;
  readonly runsMs: readonly number[];
  readonly thresholdMs: number;
  readonly timings: StartupBenchTimings;
  readonly gateOk: boolean;
  readonly exitCode: 0 | 1;
  readonly machine: BenchMachineContext;
}

/** Минимум/максимум непустой выборки (гвоздь: пустой вход — ошибка, как в medianOf). */
function minMaxOf(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) {
    throw new Error('minMaxOf: пустая выборка прогонов');
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Собирает JSON-фактуру отчёта (§5): тайминги (медиана из 062 + мин/макс),
 * гейт медианы ≤ порога, exit-код (чистая, §19).
 */
export function buildStartupBenchJson(input: StartupBenchReportInput): StartupBenchReportJson {
  const medianMs = medianOf(input.runsMs);
  const range = minMaxOf(input.runsMs);
  const timings: StartupBenchTimings = { medianMs, minMs: range.min, maxMs: range.max };
  const gateOk = evaluateBenchGate(medianMs, input.thresholdMs);
  return {
    task: 'TASK-111',
    kind: 'startup',
    dateUtc: input.dateUtc,
    exe: input.exe,
    runsMs: [...input.runsMs],
    thresholdMs: input.thresholdMs,
    timings,
    gateOk,
    exitCode: gateOk ? 0 : 1,
    machine: { ...input.machine },
  };
}

/** Округление до 1 знака для текстового отчёта (прецедент bench-report). */
function ms(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Человекочитаемый отчёт (§5: «отчёт JSON+текст»; английский — §16). Содержит
 * машину-контекст, прогоны, медиану/мин/макс и вердикт (§20 AC4 069).
 */
export function buildStartupBenchText(report: StartupBenchReportJson): string {
  const verdict = report.gateOk
    ? 'verdict: PASS — median within the spec gate; baseline recorded (tools/bench-results)'
    : `verdict: FAIL — median gate: ${ms(report.timings.medianMs)} > ${report.thresholdMs}` +
      ' — changing the gate is an NFR-4 revision (spec §13)';
  const lines = [
    `TASK-111: startup bench (NFR-4: packaged cold start → first meaningful frame, gate <= ${report.thresholdMs} ms)`,
    `date: ${report.dateUtc}`,
    `machine: cpu="${report.machine.cpu}" platform=${report.machine.platform}` +
      ` node=${report.machine.nodeVersion}` +
      (report.machine.electronVersion === undefined
        ? ''
        : ` electron=${report.machine.electronVersion}`),
    `exe: ${report.exe}`,
    '',
    `runs (ms): ${report.runsMs.map(ms).join(', ')}`,
    `median: ${ms(report.timings.medianMs)} (threshold ${report.thresholdMs}) → ${report.gateOk ? 'PASS' : 'FAIL'}`,
    `min: ${ms(report.timings.minMs)}; max: ${ms(report.timings.maxMs)}`,
    '',
    verdict,
  ];
  return lines.join('\n');
}
