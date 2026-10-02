/**
 * TASK-102: крэш-тест потери питания (NFR-3) — «kill -9 во время записи — ноль
 * потерянных сохранённых записей» (§2/§5).
 *
 * МЕХАНИКА (§5): N итераций, каждая на СВОЕЙ tmp-userData (свежая БД):
 *  (1) launchApp(tmp-userData, HL_TEST_HOOKS=1) — запуск собранного приложения;
 *  (2) калибровка: `calibration` батчей по `batch` записей через test-only канал
 *      `__test/insert-batch` (каждый — ОДНА транзакция + bump data_version за
 *      запись, §8/§9); последний committedTotal — ack-оракул; заодно фиксируем
 *      schemaVersion здорового старта (канал app/meta);
 *  (3) рабочий цикл: батчи идут подряд, ack-и трекаются; момент килла выбран
 *      заранее детерминированным PRNG (seed) — задержка U[50,500] мс от конца
 *      калибровки («окно 50–500 мс», §5/§13); когда окно истекает — kill -9
 *      (Windows: `taskkill /F /T /PID` — /T обязателен: дочерние процессы
 *      Electron держат tmp-userData; §22: жёстче ОС-выключения — flush-шансов
 *      нет). Интерпретация §5 (зафиксировано): килл «между ack'ами» — окно
 *      отсчитывается от последнего ack калибровки, батчи идут без пауз, поэтому
 *      килл обычно попадает ВНУТРЬ очередного батча (случай «батч в полёте» §8);
 *      попадание в микропаузу IPC даёт второй случай («килл в паузе»); оба
 *      разрешены инвариантом;
 *  (4) перезапуск: ГРАЦИОЗНЫЙ запуск НОВОГО процесса на той же tmp-userData
 *      (не переиспользование, §13) → канал `__test/db-state` даёт
 *      {count, dataVersion, schemaVersion} (§11); отказ канала = БД не открыта
 *      (recovery после порчи) — итерация честно FAIL (синтетические −1 дают
 *      LOST_ACK+DATA_VERSION_MISMATCH+SCHEMA_MISMATCH);
 *  (5) вердикт итерации — evaluateCrashIteration (§8: found ∈ {ack, ack+batch},
 *      dv == 1 + found, схема == калибровочной); запись в отчёт.
 *
 * ОТЧЁТ (§18): JSON (tools/crash-results/<date>.json — в .gitignore) + текст в
 * консоль; exit 0 — все итерации PASS, 1 — есть нарушение, 2 — ошибка среды.
 *
 * ДЕТЕРМИНИЗМ (§13): seed → одна и та же последовательность киллов (регресс-
 * сравнение); дефолтный seed — константа кода (не часы).
 *
 * БЮДЖЕТ (§15/§20 AC5): итерация ~5–15 с; N=10 → 2–3 мин (полный ≤5 мин);
 * smoke (1 итерация, калибровка 2 батчей) — механика ≤30 с.
 *
 * ЗАПУСК: `pnpm test:crash [--iterations N] [--batch N] [--calibration N]
 * [--seed S] [--kill-min-ms MS] [--kill-max-ms MS] [--smoke] [--out-dir DIR]
 * [--json]`. ПРЕДПОСЫЛКА: собранные dist/main и dist-renderer (§22 — прецедент
 * e2e TASK-035: `pnpm --filter @hl/desktop build`).
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildCrashReportJson,
  buildCrashReportText,
  evaluateCrashIteration,
  mulberry32,
  randomIntBetween,
} from './lib/crash-report.js';
import { closeApp, launchApp } from '../../apps/desktop/tests/e2e/helpers/launch.js';

const execFileAsync = promisify(execFile);

/** Корень пакета @hl/desktop — проверка предпосылки «есть сборка» (§22). */
const APP_ROOT = join(fileURLToPath(new URL('../../apps/desktop/', import.meta.url)));
const MAIN_ENTRY = join(APP_ROOT, 'dist', 'main', 'app', 'bootstrap.js');

/** Дефолты прогона (§5: N=10, батчи по 50, калибровка 10 батчей; seed — константа). */
const DEFAULT_ITERATIONS = 10;
const DEFAULT_BATCH = 50;
const DEFAULT_CALIBRATION = 10;
const DEFAULT_SEED = 20261002;
const DEFAULT_KILL_MIN_MS = 50;
const DEFAULT_KILL_MAX_MS = 500;

/** Пресет smoke (§19: 1 итерация, механика ≤30 с — «5 батчей»: 2 калибровка + килл в первых). */
const SMOKE_ITERATIONS = 1;
const SMOKE_CALIBRATION = 2;

/** Таймауты шагов, мс (запуск приложения — самый долгий шаг; §20 AC5 smoke ≤30 с). */
const TIMEOUT_LAUNCH_MS = 60_000;
const TIMEOUT_INVOKE_MS = 15_000;
const TIMEOUT_EXIT_MS = 20_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Гонка-таймаут: reject через ms (unref — не держит процесс; прецедент bench-chart). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`таймаут ${label} (${ms} мс)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Вызов test-канала через мост рендерера; возвращает data ok-конверта. */
async function invokeChannel(window, channel, payload) {
  const envelope = await window.evaluate(
    async ({ channel, payload }) => {
      if (globalThis.hl === undefined) {
        throw new Error('мост window.hl недоступен — рендерер не загрузился?');
      }
      return globalThis.hl.invoke(channel, payload);
    },
    { channel, payload },
  );
  if (envelope?.ok !== true) {
    const code = envelope?.error?.code ?? 'нет конверта';
    throw new Error(`канал ${channel} отклонён: ${code}`);
  }
  return envelope.data;
}

/** Ожидание живого моста рендерера (прецедент waitForBenchBridge bench-chart). */
async function waitForBridge(window) {
  await window.waitForFunction(
    () => globalThis.hl !== undefined,
    undefined,
    { timeout: TIMEOUT_INVOKE_MS },
  );
}

/**
 * kill -9 (§5: Windows — taskkill /F /PID; /T — дерево: дочерние процессы
 * Electron держат файлы tmp-userData). Ждём exit-событие (§22: /F не всегда
 * мгновенен — таймаут TIMEOUT_EXIT_MS, дальше диагностика итерации всё равно
 * честная — перезапуск покажет фактическое состояние БД).
 */
async function killHard(electronApp) {
  const proc = electronApp.process();
  const exited = new Promise((resolveExit) => {
    proc.once('exit', () => resolveExit());
  });
  const pid = proc.pid;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)]).catch(() => undefined);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // процесс уже мёртв — килл удался
    }
  }
  await Promise.race([exited, sleep(TIMEOUT_EXIT_MS)]);
}

/** Одна итерация (§5): своя tmp-userData, калибровка → батчи → kill -9 → перезапуск → вердикт. */
async function runIteration({ index, seed, batch, calibration, killMinMs, killMaxMs }) {
  const startedAt = Date.now();
  const userData = await mkdtemp(join(tmpdir(), 'hl-crash-'));
  // Детерминированный план килла (§13): своя ветка PRNG на итерацию — seed +
  // номер итерации: сцена k-й итерации повторяется от прогона к прогону.
  const next = mulberry32((seed ^ (index * 0x9e3779b9)) >>> 0);
  const killDelayMs = randomIntBetween(next, killMinMs, killMaxMs);
  let ack = 0;
  let expectedSchemaVersion = 0;
  let batchInFlight = false;
  let error;
  /** Живые экземпляры приложения — страховка graceful-close перед rm (Windows). */
  let first;
  let second;
  try {
    // (1)+(2) Запуск + калибровка (10 батчей ack'нуты, §5).
    first = await withTimeout(launchApp({ userData, testHooks: true }), TIMEOUT_LAUNCH_MS, 'запуск 1');
    const window = await withTimeout(first.firstWindow(), TIMEOUT_LAUNCH_MS, 'окно 1');
    await window.waitForLoadState('domcontentloaded');
    await withTimeout(waitForBridge(window), TIMEOUT_INVOKE_MS, 'мост 1');
    const meta = await withTimeout(
      invokeChannel(window, 'app/meta', {}),
      TIMEOUT_INVOKE_MS,
      'app/meta',
    );
    expectedSchemaVersion = meta.schemaVersion;
    for (let i = 0; i < calibration; i += 1) {
      const data = await withTimeout(
        invokeChannel(window, '__test/insert-batch', { count: batch }),
        TIMEOUT_INVOKE_MS,
        'калибровка',
      );
      ack = data.committedTotal;
    }

    // (3) Рабочий цикл: батчи подряд; окно килла — детерминированная задержка
    // от конца калибровки; батч, отправленный на момент истечения окна, — «в полёте».
    const deadline = Date.now() + killDelayMs;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      batchInFlight = true;
      const batchPromise = withTimeout(
        invokeChannel(window, '__test/insert-batch', { count: batch }),
        TIMEOUT_INVOKE_MS,
        'батч',
      ).then(
        (data) => {
          ack = data.committedTotal;
          batchInFlight = false;
        },
        () => {
          // ack не доехал (процесс убит) — ack остаётся прежним (оракул §2)
        },
      );
      await Promise.race([batchPromise, sleep(remainingMs)]);
      if (Date.now() >= deadline) {
        break; // килл по окну: batchInFlight честно отражает, ждал ли мы ack
      }
      await batchPromise;
    }

    // kill -9 (§5: taskkill /F /T /PID на Windows).
    await killHard(first);
    first = undefined; // закрыт жёстко — страховке ниже делать нечего

    // (4) Перезапуск: ГРАЦИОЗНЫЙ запуск НОВОГО процесса (не переиспользование, §13).
    second = await withTimeout(launchApp({ userData, testHooks: true }), TIMEOUT_LAUNCH_MS, 'запуск 2');
    const window2 = await withTimeout(second.firstWindow(), TIMEOUT_LAUNCH_MS, 'окно 2');
    await window2.waitForLoadState('domcontentloaded');
    await withTimeout(waitForBridge(window2), TIMEOUT_INVOKE_MS, 'мост 2');
    const state = await withTimeout(
      invokeChannel(window2, '__test/db-state', {}),
      TIMEOUT_INVOKE_MS,
      '__test/db-state',
    );

    // (5) Вердикт итерации (§8: found ∈ {ack, ack+batch}, dv == 1 + found, схема).
    const verdict = evaluateCrashIteration({
      ack,
      found: state.count,
      dataVersion: state.dataVersion,
      schemaVersion: state.schemaVersion,
      expectedSchemaVersion,
      batchSize: batch,
      batchInFlight,
    });
    return {
      index,
      ack,
      found: state.count,
      dataVersion: state.dataVersion,
      schemaVersion: state.schemaVersion,
      batchInFlight,
      killMode: batchInFlight ? 'in-flight' : 'idle',
      durationMs: Date.now() - startedAt,
      verdict,
    };
  } catch (cause) {
    // Отказ шага итерации (запуск/канал/таймаут): БД не проверена — честный FAIL
    // с синтетическими −1 (конвейер вердикта даёт LOST_ACK + оба MISMATCH).
    error = cause instanceof Error ? cause.message : String(cause);
    return {
      index,
      ack,
      found: -1,
      dataVersion: -1,
      schemaVersion: -1,
      batchInFlight,
      killMode: batchInFlight ? 'in-flight' : 'idle',
      durationMs: Date.now() - startedAt,
      verdict: evaluateCrashIteration({
        ack,
        found: -1,
        dataVersion: -1,
        schemaVersion: -1,
        expectedSchemaVersion,
        batchSize: batch,
        batchInFlight,
      }),
      error,
    };
  } finally {
    // Graceful-закрытие перезапущенного (и уцелевшего первого) процесса — БЕЗ
    // него Windows держит файлы tmp-userData и rm не удастся (§22).
    for (const app of [second, first]) {
      if (app !== undefined) {
        await closeApp(app).catch(() => undefined);
      }
    }
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Параметры прогона (§5 + точки ввода smoke §19 и демо чувствительности §20-3). */
export async function crashTestRun(options = {}) {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const batch = options.batch ?? DEFAULT_BATCH;
  const calibration = options.calibration ?? DEFAULT_CALIBRATION;
  const seed = options.seed ?? DEFAULT_SEED;
  const killMinMs = options.killMinMs ?? DEFAULT_KILL_MIN_MS;
  const killMaxMs = options.killMaxMs ?? DEFAULT_KILL_MAX_MS;
  const outDir = resolve(
    options.outDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'crash-results'),
  );
  const startedAtUtc = Date.now();

  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`нет сборки main: ${MAIN_ENTRY} — pnpm --filter @hl/desktop build (§22)`);
  }

  const records = [];
  for (let index = 1; index <= iterations; index += 1) {
    const record = await runIteration({ index, seed, batch, calibration, killMinMs, killMaxMs });
    records.push(record);
    const verdictText = record.verdict.pass
      ? 'PASS'
      : `FAIL(${record.verdict.violations.join(',')})`;
    console.log(
      `#${record.index} [${record.killMode}] ack=${record.ack} found=${record.found} dv=${record.dataVersion} ${verdictText} ${record.durationMs}мс`,
    );
    if (record.error !== undefined) {
      console.warn(`#${record.index} ошибка шага: ${record.error}`);
    }
  }

  const json = buildCrashReportJson({
    seed,
    batchSize: batch,
    calibrationBatches: calibration,
    records,
    startedAtUtc,
    durationMs: Date.now() - startedAtUtc,
    machine: {
      platform: process.platform,
      nodeVersion: process.version,
    },
  });
  const text = buildCrashReportText(json);

  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, `${json.startedAtUtc.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(reportPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  return { exitCode: json.exitCode, json, text, reportPath };
}

/** CLI (прецедент bench-chart.mjs): флаги прогона + smoke-пресет. */
const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = argv[1] === undefined ? undefined : resolve(argv[1]);
if (invokedPath === scriptPath) {
  let cliIterations;
  let cliBatch;
  let cliCalibration;
  let cliSeed;
  let cliKillMinMs;
  let cliKillMaxMs;
  let cliOutDir;
  let cliJson = false;
  let cliSmoke = false;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };
    if (flag === '--iterations') cliIterations = Number(next());
    else if (flag === '--batch') cliBatch = Number(next());
    else if (flag === '--calibration') cliCalibration = Number(next());
    else if (flag === '--seed') cliSeed = Number(next());
    else if (flag === '--kill-min-ms') cliKillMinMs = Number(next());
    else if (flag === '--kill-max-ms') cliKillMaxMs = Number(next());
    else if (flag === '--out-dir') cliOutDir = next();
    else if (flag === '--json') cliJson = true;
    else if (flag === '--smoke') cliSmoke = true;
    else {
      console.error(`неизвестный флаг: ${String(flag)}`);
      console.error(
        'usage: pnpm test:crash [--iterations N] [--batch N] [--calibration N] [--seed S] [--kill-min-ms MS] [--kill-max-ms MS] [--out-dir DIR] [--json] [--smoke]',
      );
      exit(2);
    }
  }
  try {
    const result = await crashTestRun({
      ...(cliSmoke ? { iterations: SMOKE_ITERATIONS, calibration: SMOKE_CALIBRATION } : {}),
      ...(cliIterations === undefined ? {} : { iterations: cliIterations }),
      ...(cliBatch === undefined ? {} : { batch: cliBatch }),
      ...(cliCalibration === undefined ? {} : { calibration: cliCalibration }),
      ...(cliSeed === undefined ? {} : { seed: cliSeed }),
      ...(cliKillMinMs === undefined ? {} : { killMinMs: cliKillMinMs }),
      ...(cliKillMaxMs === undefined ? {} : { killMaxMs: cliKillMaxMs }),
      ...(cliOutDir === undefined ? {} : { outDir: cliOutDir }),
    });
    console.log(cliJson ? JSON.stringify(result.json, null, 2) : result.text);
    console.error(`report: ${result.reportPath}`);
    exit(result.exitCode);
  } catch (error) {
    console.error(`test:crash: среда сломана — exit 2: ${String(error)}`);
    exit(2);
  }
}
