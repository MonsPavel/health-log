/**
 * TASK-062 §5 шаг 5/§13/§19: чистая либа отчёта bench графика — медианы, гейты,
 * форматтеры (текст + JSON). Файл отделён от bench-chart.mjs ради юнит-тестов
 * (tools-scripts-проект Vitest, прецедент size-audit): ФС/процессов здесь нет —
 * только расчёты и строки. Отчёт — английский (§16: dev-инструмент; прецедент
 * size-audit.mjs). Пороги гейтов — из §2 задачи: сборка series ≤200 мс, рендер
 * ≤800 мс (суммарно <1 с, NFR-4-компонент); их изменение = ревизия NFR-4 (§13).
 */

/** Порог гейта канала trend/series, мс (§2/§5: сборка series ≤200). */
export const BENCH_GATE_CHANNEL_MS = 200;

/** Порог гейта рендера графика, мс (§2/§5: рендер ≤800). */
export const BENCH_GATE_RENDER_MS = 800;

/**
 * Медиана выборки (§13: «медиана 3 прогонов, не минимум» — честность замера).
 * Нечётный набор — срединный элемент; чётный — среднее двух средин; сортировка
 * локальная (вход не мутируется), одиночное значение — само.
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('medianOf: пустая выборка прогонов');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Гейт одного порога (§5): «≤» — прохождение включает равенство порогу
 * (мс — числа с плавающей: точное равенство не ожидается, но семантика ≤).
 */
export function evaluateBenchGate(medianMs: number, thresholdMs: number): boolean {
  return medianMs <= thresholdMs;
}

/** Машина-контекст отчёта (§13: «строка, не гарантия» — из ОС, без претензий). */
export interface BenchMachineContext {
  /** Класс CPU из OS (os.cpus()[0].model) или 'unknown'. */
  readonly cpu: string;
  /** Платформа (process.platform). */
  readonly platform: string;
  /** Версия Node bench-раннера. */
  readonly nodeVersion: string;
  /** Версия Electron замеренного приложения (из process.versions окна, если доступна). */
  readonly electronVersion?: string;
}

/** Вход отчёта: контекст прогона + наборы прогонов + пороги (точки ввода тестов). */
export interface BenchReportInput {
  /** Сколько записей посеяно (10k bench / 100 smoke). */
  readonly count: number;
  /** Период замера (бенч — 'all'). */
  readonly period: string;
  /** Фактический режим серий из ответа канала ('raw'|'daily'; undefined — не получен). */
  readonly mode?: string;
  /** Прогоны замера A (канал trend/series из рендерера), мс — прогрев не входит (§13). */
  readonly channelRunsMs: readonly number[];
  /** Прогоны замера B (рендер графика), мс — прогрев не входит (§13). */
  readonly renderRunsMs: readonly number[];
  /** Пороги гейтов (по умолчанию §2; smoke-вариант может ужесточать — §20 AC2). */
  readonly thresholds: { channelMs: number; renderMs: number };
  readonly machine: BenchMachineContext;
  /** Момент прогона (ISO UTC) — имя файла отчёта и факт для истории bench (§23). */
  readonly dateUtc: string;
}

/** Медианы прогона (§5 шаг 5: «медиана 3 прогонов»). */
export interface BenchMedians {
  readonly channelMs: number;
  readonly renderMs: number;
  readonly totalMs: number;
}

/** Результат гейтов (§5): оба порога → суммарный вердикт. */
export interface BenchGateResult {
  readonly channelOk: boolean;
  readonly renderOk: boolean;
  readonly ok: boolean;
}

/** Форма JSON-отчёта (§18: файл tools/bench-results/<date>.json). */
export interface BenchReportJson {
  readonly task: 'TASK-062';
  readonly dateUtc: string;
  readonly count: number;
  readonly period: string;
  readonly mode?: string;
  readonly channelRunsMs: readonly number[];
  readonly renderRunsMs: readonly number[];
  readonly thresholds: { channelMs: number; renderMs: number };
  readonly medians: BenchMedians;
  readonly gates: BenchGateResult;
  readonly exitCode: 0 | 1;
  readonly machine: BenchMachineContext;
}

/** Собирает JSON-фактуру отчёта: медианы + гейты + exit-код (чистая, §19). */
export function buildBenchJson(input: BenchReportInput): BenchReportJson {
  const channelMs = medianOf(input.channelRunsMs);
  const renderMs = medianOf(input.renderRunsMs);
  // Оба флага — до литерала: ok в BenchGateResult readonly (мутации нет).
  const channelOk = evaluateBenchGate(channelMs, input.thresholds.channelMs);
  const renderOk = evaluateBenchGate(renderMs, input.thresholds.renderMs);
  const gates: BenchGateResult = {
    channelOk,
    renderOk,
    ok: channelOk && renderOk,
  };
  return {
    task: 'TASK-062',
    dateUtc: input.dateUtc,
    count: input.count,
    period: input.period,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    channelRunsMs: [...input.channelRunsMs],
    renderRunsMs: [...input.renderRunsMs],
    thresholds: { ...input.thresholds },
    medians: { channelMs, renderMs, totalMs: channelMs + renderMs },
    gates,
    exitCode: gates.ok ? 0 : 1,
    machine: { ...input.machine },
  };
}

/** Округление до 1 знака для текстового отчёта (без дробного шума rAF-замеров). */
function ms(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Проваленные гейты для вердикта (§20 AC2: FAIL с разметкой гейта). */
function failedGatesOf(report: BenchReportJson): string[] {
  const failed: string[] = [];
  if (!report.gates.channelOk) {
    failed.push(`channel gate: ${ms(report.medians.channelMs)} > ${report.thresholds.channelMs}`);
  }
  if (!report.gates.renderOk) {
    failed.push(`render gate: ${ms(report.medians.renderMs)} > ${report.thresholds.renderMs}`);
  }
  return failed;
}

/**
 * Человекочитаемый отчёт (§5: «отчёт: JSON+текст»; английский — §16). Содержит
 * машину-контекст (§13), прогон-наборы, медианы, гейты и вердикт PASS/FAIL.
 */
export function buildBenchText(report: BenchReportJson): string {
  const verdict = report.gates.ok
    ? 'verdict: PASS — medians within the spec gates; baseline recorded (tools/bench-results)'
    : `verdict: FAIL — ${failedGatesOf(report).join('; ')} — changing the gates is an NFR-4 revision (spec §13)`;
  const lines = [
    `TASK-062: chart bench (NFR-4 component: series build <=200 ms, render <=800 ms)`,
    `date: ${report.dateUtc}`,
    `machine: cpu="${report.machine.cpu}" platform=${report.machine.platform} node=${report.machine.nodeVersion}` +
      (report.machine.electronVersion === undefined
        ? ''
        : ` electron=${report.machine.electronVersion}`),
    `profile: records: ${report.count}, period: ${report.period}` +
      (report.mode === undefined ? '' : `, mode: ${report.mode}`),
    '',
    `channel runs (ms): ${report.channelRunsMs.map(ms).join(', ')}`,
    `render runs (ms): ${report.renderRunsMs.map(ms).join(', ')}`,
    `channel median: ${ms(report.medians.channelMs)} (threshold ${report.thresholds.channelMs}) → ${report.gates.channelOk ? 'PASS' : 'FAIL'}`,
    `render median: ${ms(report.medians.renderMs)} (threshold ${report.thresholds.renderMs}) → ${report.gates.renderOk ? 'PASS' : 'FAIL'}`,
    `total: ${ms(report.medians.totalMs)} (target <1000) → ${report.gates.ok ? 'PASS' : 'FAIL'}`,
    '',
    verdict,
  ];
  return lines.join('\n');
}
