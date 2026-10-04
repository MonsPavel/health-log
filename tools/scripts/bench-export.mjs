/**
 * TASK-111: bench экспорта CSV 50 000 записей (§5/§2 NFR-4: экспорт 50k <60 с) —
 * воспроизводимый прогон ПОЛНОГО пути report/export-csv:
 *  (1) tmp-userData + tmp-БД, запуск приложения в bench-режиме (launchApp 062:
 *      HL_BENCH=1 → канал `__bench/seed` + bench-ветка saver-а);
 *  (2) сид 50 000 записей (детерминированный seed — ОБЩИЙ генератор TASK-062 на
 *      main-стороне, одна транзакция; профиль NFR-9 — «дневник на годы»);
 *  (3) invoke канала `report/export-csv` {profileId} из РЕНДЕРЕРА — wall-time
 *      вокруг invoke (семантика measureChannel 062); use case 065 генерирует CSV
 *      (063) и пишет через bench-ветку saver-а 069 (HL_BENCH=1, не-packaged →
 *      авто-запись в tmp-userData/bench-saves без диалога — узаконенный test-hook);
 *  (4) повтор ×3 (§5), медиана — честность замера (§13 062); размер CSV — stat
 *      пути из ответа канала;
 *  (5) отчёт: JSON (tools/bench-results/<date>.json, §18, в .gitignore) + текст
 *      в stdout; гейт: медиана ≤60 000 мс (NFR-4) → exit 0/1; ошибка среды/
 *      генерации/канала → exit 2 (§13).
 *
 * Прогрев: 1 untimed-прогон (прогрев ФС-кэша чтений 50k — §13 062 «1 прогрев без
 * записи»). Имя файла bench-saves имеет минутную гранулярность (§13 065) — прогоны
 * одного таймслота перезаписывают один файл; размер мерится stat после каждого
 * прогона, путь валиден.
 *
 * Запуск: `pnpm bench:export [--count N] [--runs N] [--out-dir DIR] [--gate-ms N]
 * [--json]`. Коды возврата: 0 — гейт пройден; 1 — гейт превышен; 2 — ошибка
 * среды/вызова. ПРЕДПОСЫЛКА: собранные dist/main и dist-renderer (tsc -b
 * tsconfig.main.json + vite build) — bench запускает собранное приложение,
 * как e2e (§22 TASK-035; прецедент bench-pdf.mjs).
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import {
  BENCH_EXPORT_COUNT_DEFAULT,
  BENCH_EXPORT_GATE_MS,
  BENCH_EXPORT_RUNS_DEFAULT,
  buildExportBenchJson,
  buildExportBenchText,
} from './lib/bench-export.js';
import { closeApp, launchApp } from '../../apps/desktop/tests/e2e/helpers/launch.js';

/** Профиль-владелец сидинга (seed миграции v1; зеркало bench-pdf.mjs 069). */
const BENCH_PROFILE_ID = 'seed-profile-0001';

/** Таймауты шагов, мс (сид 50k и экспорт — с запасом на медленной машине). */
const TIMEOUT_SEED_MS = 300_000;
const TIMEOUT_MEASURE_MS = 120_000;

/** Гонка-таймаут: reject через ms, если promise не разрешился (unref — не держит процесс). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`таймаут ${label} (${ms} мс)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Ожидание загрузки страницы: preload-мост с bench-хуками доступен (§6 062). */
async function waitForBenchBridge(window) {
  await window.waitForFunction(
    () => {
      const host = /** @type {{hl?: {__bench?: unknown}}} */ (globalThis);
      return host.hl !== undefined && host.hl.__bench !== undefined;
    },
    undefined,
    { timeout: TIMEOUT_MEASURE_MS },
  );
}

/**
 * Один прогон (§5 шаг 3): wall-time invoke report/export-csv из рендерера — та же
 * семантика, что measureChannel 062 (performance.now() вокруг invoke), плюс захват
 * конверта: путь записанного файла нужен для замера размера, отказ канала или
 * отмена диалога делают прогон невалидным (в bench-режиме диалога нет — авто-запись).
 */
async function measureExportRun(window, profileId) {
  return withTimeout(
    window.evaluate(async (benchProfileId) => {
      const startedAtMs = performance.now();
      const envelope = await globalThis.hl.invoke('report/export-csv', {
        profileId: benchProfileId,
      });
      const data = /** @type {{path?: unknown}} */ (/** @type {unknown} */ (envelope?.data));
      return {
        ms: performance.now() - startedAtMs,
        ok: envelope?.ok === true,
        errorCode: envelope?.ok === true ? undefined : envelope?.error?.code,
        path: typeof data?.path === 'string' ? data.path : undefined,
        canceled: /** @type {{canceled?: unknown}} */ (/** @type {unknown} */ (envelope?.data))
          ?.canceled,
      };
    }, profileId),
    TIMEOUT_MEASURE_MS,
    'report/export-csv',
  );
}

/** Параметры прогона (§5 шаги 1–5 + точки ввода smoke/гейт-теста §19/§20). */
export async function benchExportRun(options = {}) {
  const count = options.count ?? BENCH_EXPORT_COUNT_DEFAULT;
  const runs = options.runs ?? BENCH_EXPORT_RUNS_DEFAULT;
  const outDir = resolve(
    options.outDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'bench-results'),
  );
  const thresholdMs = options.gateMs ?? BENCH_EXPORT_GATE_MS;

  const userData = await mkdtemp(join(tmpdir(), 'hl-bench-export-'));
  let app;
  try {
    // (1)–(2) tmp-userData + запуск приложения в bench-режиме (e2e-хелпер 062).
    app = await launchApp({ userData, bench: true });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await waitForBenchBridge(window);

    // (2) Сид синтетики: генерация на main-стороне, ОДНА транзакция (§8 062).
    const seed = await withTimeout(
      window.evaluate(
        async ({ benchCount }) => {
          return globalThis.hl.invoke('__bench/seed', { count: benchCount });
        },
        { benchCount: count },
      ),
      TIMEOUT_SEED_MS,
      '__bench/seed',
    );
    if (seed?.ok !== true || seed.data?.inserted !== count) {
      throw new Error(
        `__bench/seed: ожидался {ok:true, data:{inserted:${count}}}, получено ${JSON.stringify(seed)}`,
      );
    }

    // Прогрев (§13 062: 1 прогон без записи): ФС-кэш чтений 50k записей.
    const warmup = await measureExportRun(window, BENCH_PROFILE_ID);
    if (!warmup.ok || warmup.path === undefined) {
      throw new Error(
        `report/export-csv отклонён на прогреве (${warmup.errorCode ?? 'unknown'}) — bench невозможен`,
      );
    }

    // (3)–(4) Замеры ×3: медиана честности ради (§13), не минимум.
    const runsMs = [];
    const fileRunsBytes = [];
    for (let i = 0; i < runs; i += 1) {
      const measure = await measureExportRun(window, BENCH_PROFILE_ID);
      if (!measure.ok || measure.path === undefined || measure.canceled === true) {
        throw new Error(
          `report/export-csv отклонён в прогоне ${i + 1} (${measure.errorCode ?? 'unknown'}) — прогон нечестен`,
        );
      }
      runsMs.push(measure.ms);
      // Размер CSV (§5): stat пути из ответа канала (bench-ветка saver-а).
      fileRunsBytes.push((await stat(measure.path)).size);
    }

    const electronVersion = await app.evaluate(() => process.versions.electron);
    const json = buildExportBenchJson({
      count,
      runsMs,
      fileRunsBytes,
      thresholdMs,
      machine: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        platform: os.platform(),
        nodeVersion: process.version,
        ...(electronVersion === undefined ? {} : { electronVersion }),
      },
      dateUtc: new Date().toISOString(),
    });
    const text = buildExportBenchText(json);

    // (5) Отчёт: JSON-файл в tools/bench-results (§18, в .gitignore), текст — stdout.
    await mkdir(outDir, { recursive: true });
    const reportPath = join(outDir, `${json.dateUtc.replaceAll(/[:.]/g, '-')}.json`);
    await writeFile(reportPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

    return { exitCode: json.exitCode, json, text, reportPath };
  } finally {
    if (app !== undefined) {
      await closeApp(app).catch(() => undefined);
    }
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** CLI (прецедент bench-pdf.mjs): флаги --count/--runs/--out-dir/--gate-ms/--json. */
const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = argv[1] === undefined ? undefined : resolve(argv[1]);
if (invokedPath === scriptPath) {
  let cliCount;
  let cliRuns;
  let cliOutDir;
  let cliGateMs;
  let cliJson = false;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };
    if (flag === '--count') cliCount = Number(next());
    else if (flag === '--runs') cliRuns = Number(next());
    else if (flag === '--out-dir') cliOutDir = next();
    else if (flag === '--gate-ms') cliGateMs = Number(next());
    else if (flag === '--json') cliJson = true;
    else {
      console.error(`неизвестный флаг: ${String(flag)}`);
      console.error(
        'usage: pnpm bench:export [--count N] [--runs N] [--out-dir DIR] [--gate-ms N] [--json]',
      );
      exit(2);
    }
  }
  try {
    const result = await benchExportRun({
      ...(cliCount === undefined ? {} : { count: cliCount }),
      ...(cliRuns === undefined ? {} : { runs: cliRuns }),
      ...(cliOutDir === undefined ? {} : { outDir: cliOutDir }),
      ...(cliGateMs === undefined ? {} : { gateMs: cliGateMs }),
    });
    console.log(cliJson ? JSON.stringify(result.json, null, 2) : result.text);
    console.error(`report: ${result.reportPath}`);
    exit(result.exitCode);
  } catch (error) {
    console.error(`bench:export: среда/прогон сломаны — exit 2: ${String(error)}`);
    exit(2);
  }
}
