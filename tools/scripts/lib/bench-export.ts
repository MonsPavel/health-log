/**
 * TASK-111 §13: конфиг и отчёт bench экспорта CSV — чистые функции без ФС
 * (прецедент bench-pdf.ts TASK-069: либа отделена от bench-export.mjs ради
 * юнит-тестов). Медианы/гейт — функции РЕЮЗИРУЮТСЯ из bench-report.ts (§6 062:
 * «общие») — здесь только экспорт-конфиг (профиль/повторы/порог §5/§13) и сборка
 * отчёта (медиана/мин/макс, размер CSV, count записей).
 *
 * Порог гейта — из §2/§13 задачи: полный путь report/export-csv (генерация 063 →
 * запись через saver) 50 000 записей ≤60 с (NFR-4, профиль NFR-9); его изменение =
 * ревизия NFR-4. Отчёт — английский (§16: dev-инструмент, прецедент size-audit).
 */
import { evaluateBenchGate, medianOf, type BenchMachineContext } from './bench-report.js';

/** Профиль bench (§5/§9): 50 000 записей детерминированным сидом (генератор 062). */
export const BENCH_EXPORT_COUNT_DEFAULT = 50_000;

/** Повторов замера (§5/§13 062: 3 — медиана достаточно). */
export const BENCH_EXPORT_RUNS_DEFAULT = 3;

/** Порог гейта полного пути report/export-csv, мс (§2/§13: NFR-4 — 50k ≤60 с). */
export const BENCH_EXPORT_GATE_MS = 60_000;

/** Вход отчёта: контекст прогона + прогоны-замеры (точки ввода тестов). */
export interface ExportBenchReportInput {
  /** Сколько записей посеяно (50 000 bench / smoke-вариант §19). */
  readonly count: number;
  /** Прогоны wall-time invoke report/export-csv из рендерера, мс — прогрев не входит. */
  readonly runsMs: readonly number[];
  /** Размер записанного CSV по прогонам, байты (порядок = runsMs). */
  readonly fileRunsBytes: readonly number[];
  /** Порог гейта (по умолчанию §13; smoke-вариант может ужесточать — §20 AC2 062). */
  readonly thresholdMs: number;
  readonly machine: BenchMachineContext;
  /** Момент прогона (ISO UTC) — имя файла отчёта и факт для истории bench (§23 062). */
  readonly dateUtc: string;
}

/** Тайминги прогонов (§20 AC4 069: медиана/мин/макс), мс. */
export interface ExportBenchTimings {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** Размер CSV по прогонам (§20 AC4 069), байты. */
export interface ExportBenchSizes {
  readonly medianBytes: number;
  readonly minBytes: number;
  readonly maxBytes: number;
}

/** Форма JSON-отчёта (§18 062: файл tools/bench-results/<date>.json, в .gitignore). */
export interface ExportBenchReportJson {
  readonly task: 'TASK-111';
  readonly kind: 'export-csv';
  readonly dateUtc: string;
  readonly count: number;
  readonly period: 'all';
  readonly runsMs: readonly number[];
  readonly fileRunsBytes: readonly number[];
  readonly thresholdMs: number;
  readonly timings: ExportBenchTimings;
  readonly file: ExportBenchSizes;
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
 * Собирает JSON-фактуру отчёта (§5 шаг 5): тайминги (медиана из 062 + мин/макс),
 * размеры CSV, гейт медианы ≤ порога, exit-код (чистая, §19).
 */
export function buildExportBenchJson(input: ExportBenchReportInput): ExportBenchReportJson {
  const medianMs = medianOf(input.runsMs);
  const timingsRange = minMaxOf(input.runsMs);
  const timings: ExportBenchTimings = {
    medianMs,
    minMs: timingsRange.min,
    maxMs: timingsRange.max,
  };
  const sizesRange = minMaxOf(input.fileRunsBytes);
  const file: ExportBenchSizes = {
    medianBytes: medianOf(input.fileRunsBytes),
    minBytes: sizesRange.min,
    maxBytes: sizesRange.max,
  };
  const gateOk = evaluateBenchGate(medianMs, input.thresholdMs);
  return {
    task: 'TASK-111',
    kind: 'export-csv',
    dateUtc: input.dateUtc,
    count: input.count,
    period: 'all',
    runsMs: [...input.runsMs],
    fileRunsBytes: [...input.fileRunsBytes],
    thresholdMs: input.thresholdMs,
    timings,
    file,
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
 * машину-контекст, прогоны, медиану/мин/макс, размер CSV, count и вердикт.
 */
export function buildExportBenchText(report: ExportBenchReportJson): string {
  const verdict = report.gateOk
    ? 'verdict: PASS — median within the spec gate; baseline recorded (tools/bench-results)'
    : `verdict: FAIL — median gate: ${ms(report.timings.medianMs)} > ${report.thresholdMs}` +
      ' — changing the gate is an NFR-4 revision (spec §13)';
  const lines = [
    `TASK-111: export bench (NFR-4: report/export-csv of ${report.count} records, gate <= ${report.thresholdMs} ms)`,
    `date: ${report.dateUtc}`,
    `machine: cpu="${report.machine.cpu}" platform=${report.machine.platform}` +
      ` node=${report.machine.nodeVersion}` +
      (report.machine.electronVersion === undefined
        ? ''
        : ` electron=${report.machine.electronVersion}`),
    `profile: records: ${report.count}, period: ${report.period}`,
    '',
    `runs (ms): ${report.runsMs.map(ms).join(', ')}`,
    `median: ${ms(report.timings.medianMs)} (threshold ${report.thresholdMs}) → ${report.gateOk ? 'PASS' : 'FAIL'}`,
    `min: ${ms(report.timings.minMs)}; max: ${ms(report.timings.maxMs)}`,
    `csv size (bytes, min/median/max): ${report.file.minBytes}/${report.file.medianBytes}/${report.file.maxBytes}`,
    '',
    verdict,
  ];
  return lines.join('\n');
}
