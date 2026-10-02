/**
 * TASK-102 §13/§18/§19: чистые функции крэш-теста потери питания (NFR-3) —
 * вердикты итераций, детерминированный PRNG сценария убийств и сборка отчёта.
 * Библиотека отдельно от CLI-скрипта crash-test.mjs: юнит-тесты (§19, §20 AC2)
 * гоняют её напрямую, без запуска Electron.
 *
 * ИНВАРИАНТЫ (§2/§8 — точная форма): транзакция батча атомарна, поэтому после
 * килла found ∈ {ack, ack + batchSize}:
 *  - found == ack — батч в полёте откатился (или килл в паузе между батчами);
 *  - found == ack + batchSize (только при батче в полёте) — транзакция дошла
 *    до диска, а ack-ответ был потерян вместе с процессом: потерянного
 *    ПОДТВЕРЖДЁННОГО нет, лишнего частичного нет;
 *  - частичный батч (ack < found < ack + batchSize) НЕВОЗМОЖЕН — его появление
 *    ловится как PARTIAL_BATCH (ровно это даёт dev-демо авто-коммита §20-3);
 *  - dv == found + CRASH_DATA_VERSION_BASE (каждая запись = +1, база 1 — §8);
 *  - schemaVersion == ожидаемой (зафиксирована здоровой калибровкой) — «схема
 *    цела» (§2).
 */

/** База формулы data_version (§8): dv == 1 + count (v1 сеет data_version = 1). */
export const CRASH_DATA_VERSION_BASE = 1;

/** Коды нарушений инвариантов (§18: попадают в отчёт по-имени). */
export type CrashViolationCode =
  'LOST_ACK' | 'PARTIAL_BATCH' | 'UNEXPECTED_TAIL' | 'DATA_VERSION_MISMATCH' | 'SCHEMA_MISMATCH';

/** Ввод вердикта одной итерации: последний ack и факты `__test/db-state` (§8). */
export interface CrashIterationInput {
  /** Последний подтверждённый committedTotal до килла (ack-оракул, §2). */
  readonly ack: number;
  /** count из `__test/db-state` после перезапуска (§11). */
  readonly found: number;
  /** dataVersion из `__test/db-state` после перезапуска (§11). */
  readonly dataVersion: number;
  /** schemaVersion из `__test/db-state` после перезапуска (§11). */
  readonly schemaVersion: number;
  /** Ожидаемая схема — зафиксирована здоровой калибровкой этой итерации. */
  readonly expectedSchemaVersion: number;
  /** Размер батча прогона (прогон — 50, §5). */
  readonly batchSize: number;
  /** Был ли батч в полёте в момент килла (не дождался ack). */
  readonly batchInFlight: boolean;
}

/** Вердикт итерации: PASS и список нарушений (пустой при PASS). */
export interface CrashIterationVerdict {
  readonly pass: boolean;
  readonly violations: readonly CrashViolationCode[];
}

/**
 * Вердикт одной итерации (§19: таблица комбинаций ack/found/dv → PASS/FAIL).
 * Все нарушения собираются в один список — отчёт честно показывает ВСЁ, что
 * сломалось, а не только первое.
 */
export function evaluateCrashIteration(input: CrashIterationInput): CrashIterationVerdict {
  const {
    ack,
    found,
    dataVersion,
    schemaVersion,
    expectedSchemaVersion,
    batchSize,
    batchInFlight,
  } = input;
  const violations: CrashViolationCode[] = [];

  // (1) Ничего подтверждённого не потеряно (§2, NFR-3, страх R-4).
  if (found < ack) {
    violations.push('LOST_ACK');
  }
  // (2) Хвост после ack объясним только атомарным батчем в полёте (§8).
  if (found > ack) {
    if (found < ack + batchSize) {
      violations.push('PARTIAL_BATCH');
    } else if (found > ack + batchSize || !batchInFlight) {
      violations.push('UNEXPECTED_TAIL');
    }
  }
  // (3) data_version согласован с числом записей (§8: dv == 1 + count).
  if (dataVersion !== found + CRASH_DATA_VERSION_BASE) {
    violations.push('DATA_VERSION_MISMATCH');
  }
  // (4) Схема цела — не изменилась/не деградировала после килла (§2).
  if (schemaVersion !== expectedSchemaVersion) {
    violations.push('SCHEMA_MISMATCH');
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Детерминированный PRNG mulberry32 (32-битный, без зависимостей) — одинаковый
 * seed даёт одинаковую последовательность решений о киллах (§13: «PRNG seed →
 * повторяемый сценарий убийств, регресс-сравнение»). Локальная копия прецедента
 * bench-seed.ts (TASK-062): main-версия не экспортируется, а тянуть её в tools
 * вместе с @hl/contracts ради 12 строк — нарушение изоляции скриптов.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Случайное целое в [min, max] включительно из PRNG (окно киллов 50–500 мс, §5). */
export function randomIntBetween(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

/** Режим килла итерации (детерминированная пара сценариев, §8 «батч в полёте»). */
export type CrashKillMode = 'idle' | 'in-flight';

/** Запись одной итерации в отчёте (§18: per-iteration ack/found/dv/verdict). */
export interface CrashIterationRecord {
  readonly index: number;
  readonly ack: number;
  readonly found: number;
  readonly dataVersion: number;
  readonly schemaVersion: number;
  readonly batchInFlight: boolean;
  readonly killMode: CrashKillMode;
  readonly durationMs: number;
  readonly verdict: CrashIterationVerdict;
}

/** Машина-контекст отчёта (§18, прецедент bench-report). */
export type CrashMachineContext = Record<string, string>;

/** JSON-отчёт прогона (§18: файл tools/crash-results + консоль). `iterations` — записи. */
export interface CrashReportJson {
  readonly tool: 'crash-test';
  readonly task: 'TASK-102';
  readonly nfr: 'NFR-3';
  readonly seed: number;
  readonly batchSize: number;
  readonly calibrationBatches: number;
  readonly startedAtUtc: string;
  readonly durationMs: number;
  readonly pass: boolean;
  readonly verdict: 'PASS' | 'FAIL';
  readonly exitCode: 0 | 1;
  readonly machine: CrashMachineContext;
  readonly iterations: readonly CrashIterationRecord[];
}

/** Опции сборки JSON-отчёта (поля прогона + записи итераций). */
export interface BuildCrashReportJsonOptions {
  readonly seed: number;
  readonly batchSize: number;
  readonly calibrationBatches: number;
  readonly records: readonly CrashIterationRecord[];
  readonly startedAtUtc: number;
  readonly durationMs: number;
  readonly machine?: CrashMachineContext;
}

/** Собирает JSON-отчёт: итог PASS/FAIL и exit-код выводятся из вердиктов (§18). */
export function buildCrashReportJson(options: BuildCrashReportJsonOptions): CrashReportJson {
  const pass = options.records.every((record) => record.verdict.pass);
  return {
    tool: 'crash-test',
    task: 'TASK-102',
    nfr: 'NFR-3',
    seed: options.seed,
    batchSize: options.batchSize,
    calibrationBatches: options.calibrationBatches,
    startedAtUtc: new Date(options.startedAtUtc).toISOString(),
    durationMs: options.durationMs,
    pass,
    verdict: pass ? 'PASS' : 'FAIL',
    exitCode: crashExitCode(options.records.map((record) => record.verdict)),
    machine: options.machine ?? {},
    iterations: options.records,
  };
}

/** Текстовый отчёт для консоли (§18: per-iteration строка + итог). */
export function buildCrashReportText(report: CrashReportJson): string {
  const lines: string[] = [];
  lines.push('Крэш-тест потери питания — TASK-102 / NFR-3 (kill -9 во время записи)');
  lines.push(
    `seed=${report.seed} итераций=${report.iterations.length} батч=${report.batchSize} калибровка=${report.calibrationBatches}×${report.batchSize}`,
  );
  for (const record of report.iterations) {
    const violations = record.verdict.violations.join(',');
    lines.push(
      `#${record.index} [${record.killMode}] ack=${record.ack} found=${record.found} dv=${record.dataVersion} schema=${record.schemaVersion} ${record.verdict.pass ? 'PASS' : `FAIL(${violations})`} ${record.durationMs}мс`,
    );
  }
  lines.push(`длительность: ${(report.durationMs / 1000).toFixed(1)} с`);
  lines.push(`ИТОГ: ${report.verdict}`);
  return lines.join('\n');
}

/** Exit-код прогона: все PASS → 0; хоть один FAIL → 1 (§18/§20 AC1). */
export function crashExitCode(verdicts: readonly CrashIterationVerdict[]): 0 | 1 {
  return verdicts.every((verdict) => verdict.pass) ? 0 : 1;
}
