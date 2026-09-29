/**
 * TASK-069 §5/§13: pdf-конфиг и отчёт bench PDF-рендера — чистые функции без ФС
 * (прецедент bench-report.ts TASK-062: файл отделён от bench-pdf.mjs ради юнит-тестов).
 * Медианы/гейт — функции РЕЮЗИСИРУЮТСЯ из bench-report.ts (§6: «общие с 062») —
 * здесь только pdf-конфиг (профиль/повторы/порог §5/§13) и сборка отчёта §20 AC4
 * (медиана/мин/макс, размер PDF, count записей).
 *
 * Порог гейта — из §2/§13 задачи: полный путь report/pdf (сборка payload → рендер
 * в пуле 067 → запись) ≤30 с (NFR-4); его изменение = ревизия NFR-4. Отчёт —
 * английский (§16: dev-инструмент, прецедент size-audit/bench-report).
 */
import { evaluateBenchGate, medianOf } from './bench-report.js';

/** Профиль bench (§5): 5000 записей детерминированным сидом (генератор 062). */
export const BENCH_PDF_COUNT_DEFAULT = 5_000;

/** Повторов замера (§5/§13): 3 — медиана достаточно (p95 из 3 не имеет смысла). */
export const BENCH_PDF_RUNS_DEFAULT = 3;

/** Порог гейта полного пути report/pdf, мс (§2/§13: NFR-4 — 5k записей ≤30 с). */
export const BENCH_PDF_GATE_MS = 30_000;

/** Машина-контекст отчёта (§13 062: «строка, не гарантия» — из ОС, без претензий). */
export interface PdfBenchMachineContext {
  /** Класс CPU из OS (os.cpus()[0].model) или 'unknown'. */
  readonly cpu: string;
  /** Платформа (process.platform). */
  readonly platform: string;
  /** Версия Node bench-раннера. */
  readonly nodeVersion: string;
  /** Версия Electron замеренного приложения (из process.versions, если доступна). */
  readonly electronVersion?: string;
}

/** Вход отчёта: контекст прогона + прогоны-замеры (точки ввода тестов). */
export interface PdfBenchReportInput {
  /** Сколько записей посеяно (5000 bench / 100 smoke §19). */
  readonly count: number;
  /** Прогоны wall-time invoke report/pdf из рендерера, мс — прогрев не входит. */
  readonly runsMs: readonly number[];
  /** Размер записанного PDF по прогонам, байты (§20 AC4; порядок = runsMs). */
  readonly fileRunsBytes: readonly number[];
  /** Порог гейта (по умолчанию §13; smoke/гейт-тест может ужесточать — §20 AC2). */
  readonly thresholdMs: number;
  readonly machine: PdfBenchMachineContext;
  /** Момент прогона (ISO UTC) — имя файла отчёта и факт для истории bench (§23). */
  readonly dateUtc: string;
}

/** Тайминги прогонов (§20 AC4: медиана/мин/макс), мс. */
export interface PdfBenchTimings {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** Размер PDF по прогонам (§20 AC4), байты. */
export interface PdfBenchSizes {
  readonly medianBytes: number;
  readonly minBytes: number;
  readonly maxBytes: number;
}

/** Форма JSON-отчёта (§18: файл tools/bench-results/<date>.json, в .gitignore). */
export interface PdfBenchReportJson {
  readonly task: 'TASK-069';
  readonly dateUtc: string;
  readonly count: number;
  readonly period: 'all';
  readonly runsMs: readonly number[];
  readonly fileRunsBytes: readonly number[];
  readonly thresholdMs: number;
  readonly timings: PdfBenchTimings;
  readonly file: PdfBenchSizes;
  readonly gateOk: boolean;
  readonly exitCode: 0 | 1;
  readonly machine: PdfBenchMachineContext;
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
 * размеры PDF, гейт медианы ≤ порога, exit-код (чистая, §19).
 */
export function buildPdfBenchJson(input: PdfBenchReportInput): PdfBenchReportJson {
  const medianMs = medianOf(input.runsMs);
  const timingsRange = minMaxOf(input.runsMs);
  const timings: PdfBenchTimings = {
    medianMs,
    minMs: timingsRange.min,
    maxMs: timingsRange.max,
  };
  const sizesRange = minMaxOf(input.fileRunsBytes);
  const file: PdfBenchSizes = {
    medianBytes: medianOf(input.fileRunsBytes),
    minBytes: sizesRange.min,
    maxBytes: sizesRange.max,
  };
  const gateOk = evaluateBenchGate(medianMs, input.thresholdMs);
  return {
    task: 'TASK-069',
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
 * машину-контекст, прогоны, медиану/мин/макс, размер PDF, count и вердикт (§20 AC4).
 */
export function buildPdfBenchText(report: PdfBenchReportJson): string {
  const verdict = report.gateOk
    ? 'verdict: PASS — median within the spec gate; baseline recorded (tools/bench-results)'
    : `verdict: FAIL — median gate: ${ms(report.timings.medianMs)} > ${report.thresholdMs}` +
      ' — changing the gate is an NFR-4 revision (spec §13)';
  const lines = [
    `TASK-069: pdf bench (NFR-4: full report/pdf path, gate <= ${report.thresholdMs} ms)`,
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
    `pdf size (bytes, min/median/max): ${report.file.minBytes}/${report.file.medianBytes}/${report.file.maxBytes}`,
    '',
    verdict,
  ];
  return lines.join('\n');
}
