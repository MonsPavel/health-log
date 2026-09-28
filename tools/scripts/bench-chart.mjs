/**
 * TASK-062: bench графика на 10k точек (§2/§5) — воспроизводимый прогон:
 *  (1) tmp-userData + tmp-БД, генерация 10 000 записей за 3 года (детерминированный
 *      PRNG с seed, форма день/вечер+шум — генератор живёт на main-стороне,
 *      bench-seed.ts §8: генерация в одной транзакции, канал только при HL_BENCH=1);
 *  (2) запуск приложения в e2e-режиме (reuse launchApp §6) на периоде «всё»
 *      (#/dashboard?period=all — URL-семантики TASK-044/057);
 *  (3) замер A: время ответа канала trend/series из РЕНДЕРЕРА (§5 РЕШЕНИЕ:
 *      performance.now() вокруг invoke — хук window.hl.__bench.measureChannel);
 *  (4) замер B: рендер — performance.mark/measure вокруг монтирования РЕАЛЬНОГО
 *      графика: точка «данные получены» (штамп разрешения trend/series в
 *      preload) → «paint завершён» (двойной rAF) — window.hl.__bench.measureRender;
 *  (5) отчёт: JSON-файл (tools/bench-results/<date>.json, §18, в .gitignore) +
 *      текст в stdout (медиана прогонов, §13); гейты A ≤200 мс, B ≤800 мс (§2)
 *      → exit 0/1. Изменение порогов = ревизия NFR-4 (§13).
 *
 * ЧЕСТНОСТЬ ЗАМЕРА (§13): медиана 3 прогонов (не минимум); 1 прогрев без записи;
 * машина-контекст в отчёте. Прогрев B заодно кэширует чанки и даёт missed-детекции
 * калибровку. Между прогонами B — перезагрузка страницы: холодный кэш React Query
 * (keepPreviousData/staleTime-семантики otherwise показывают график мгновенно —
 * прогон нечестен, missed:true от хука).
 *
 * Статистика: медиана по bench-report.ts (чистые функции + юнит-тесты там же).
 * Запуск: `pnpm bench:chart [--count N] [--runs N] [--out-dir DIR] [--gate-channel-ms N]
 * [--gate-render-ms N] [--json]`. Коды возврата: 0 — гейты пройдены; 1 — гейт
 * превышен; 2 — ошибка среды/вызова (нет сборки, отказ канала, таймаут).
 *
 * ПРЕДПОСЫЛКА: собранные dist/main и dist-renderer (tsc -b tsconfig.main.json +
 * vite build) — bench запускает собранное приложение, как e2e (§22 TASK-035).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import {
  BENCH_GATE_CHANNEL_MS,
  BENCH_GATE_RENDER_MS,
  buildBenchJson,
  buildBenchText,
} from './lib/bench-report.js';
import {
  benchMeasureChannel,
  benchMeasureRender,
  closeApp,
  launchApp,
} from '../../apps/desktop/tests/e2e/helpers/launch.js';

/** Профиль-владелец сидинга (seed миграции v1; зеркало PROFILE_ID рендерера). */
const BENCH_PROFILE_ID = 'seed-profile-0001';

/** Маршрут журнала — точка перезагрузки между прогонами B (графика там нет). */
const JOURNAL_HASH = '#/journal';

/** Маршрут bench-замера: период «всё» (§5 шаг 2). */
const DASHBOARD_ALL_HASH = '#/dashboard?period=all';

/** Таймауты шагов, мс (запуск приложения — самый долгий шаг). */
const TIMEOUT_SEED_MS = 120_000;
const TIMEOUT_MEASURE_MS = 30_000;

/** Попыток прогона B при missed (фигура уже в DOM — кэш): теоретически не бывает после reload. */
const RENDER_MAX_ATTEMPTS = 3;

/** Гонка-таймаут: reject через ms, если promise не разрешился (unref — не держит процесс). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`таймаут ${label} (${ms} мс)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Ожидание загрузки страницы после reload: preload-мост с bench-хуками доступен. */
async function waitForBenchBridge(window) {
  await window.waitForFunction(() => {
    const host = /** @type {{hl?: {__bench?: unknown}}} */ (globalThis);
    return host.hl !== undefined && host.hl.__bench !== undefined;
  }, undefined, { timeout: TIMEOUT_MEASURE_MS });
}

/**
 * Один прогон B (§5 шаг 4): журнал → перезагрузка (холодный кэш React Query) →
 * ожидание моста → measureRender(переход на /dashboard?period=all) →
 * «данные получены → paint завершён». missed → повтор (максимум RENDER_MAX_ATTEMPTS).
 */
async function measureRenderRun(window) {
  let lastMissed = true;
  for (let attempt = 1; attempt <= RENDER_MAX_ATTEMPTS; attempt += 1) {
    await window.evaluate((hash) => {
      window.location.hash = hash;
    }, JOURNAL_HASH);
    await window.reload();
    await window.waitForLoadState('domcontentloaded');
    await waitForBenchBridge(window);
    const measure = await withTimeout(
      benchMeasureRender(window, DASHBOARD_ALL_HASH),
      TIMEOUT_MEASURE_MS,
      'measureRender',
    );
    if (!measure.missed) {
      return measure.ms;
    }
    lastMissed = measure.missed;
  }
  throw new Error(`measureRender: ${RENDER_MAX_ATTEMPTS} попыток подряд missed=${String(lastMissed)} — график монтируется из кэша, прогон нечестен`);
}

/** Замер режима серий (для отчёта §5): untimed вызов trend/series «всё». */
async function fetchSeriesMode(window) {
  const raw = await window.evaluate(async ({ profileId }) => {
    const envelope = await globalThis.hl.invoke('trend/series', {
      profileId,
      period: 'all',
    });
    const data = /** @type {{mode?: string; points?: unknown[]; days?: unknown[]}} */ (
      /** @type {unknown} */ (envelope?.data)
    );
    return {
      ok: envelope?.ok === true,
      mode: data?.mode,
      points: data?.points?.length,
      days: data?.days?.length,
    };
  }, { profileId: BENCH_PROFILE_ID });
  if (!raw.ok) {
    throw new Error(`trend/series отклонён: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Параметры прогона (§5 шаг 1–5 + точки ввода smoke/тестов §19/§20). */
export async function benchChartRun(options = {}) {
  const count = options.count ?? 10_000;
  const runs = options.runs ?? 3;
  const outDir = resolve(options.outDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'bench-results'));
  const thresholds = {
    channelMs: options.gateChannelMs ?? BENCH_GATE_CHANNEL_MS,
    renderMs: options.gateRenderMs ?? BENCH_GATE_RENDER_MS,
  };

  const userData = await mkdtemp(join(tmpdir(), 'hl-bench-'));
  let app;
  try {
    // (1)–(2) tmp-userData + запуск приложения в bench-режиме (e2e-хелпер §6).
    app = await launchApp({ userData, bench: true });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await waitForBenchBridge(window);

    // (1) Сид синтетики: генерация на main-стороне, ОДНА транзакция (§8/§9).
    const seed = await withTimeout(
      window.evaluate(async ({ benchCount }) => {
        return globalThis.hl.invoke('__bench/seed', { count: benchCount });
      }, { benchCount: count }),
      TIMEOUT_SEED_MS,
      '__bench/seed',
    );
    if (seed?.ok !== true || seed.data?.inserted !== count) {
      throw new Error(`__bench/seed: ожидался {ok:true, data:{inserted:${count}}}, получено ${JSON.stringify(seed)}`);
    }

    // Прогрев (§13: 1 прогон без записи) + фактический режим серий для отчёта.
    const warmup = await benchMeasureChannel(window, 'trend/series', {
      profileId: BENCH_PROFILE_ID,
      period: 'all',
    });
    if (!warmup.ok) {
      throw new Error('trend/series отклонён на прогреве — bench невозможен');
    }
    const series = await fetchSeriesMode(window);
    await measureRenderRun(window); // прогрев B — без записи (§13)

    // (3) Замер A: медиана прогонов round-trip канала из рендерера.
    const channelRunsMs = [];
    for (let i = 0; i < runs; i += 1) {
      const measure = await withTimeout(
        benchMeasureChannel(window, 'trend/series', {
          profileId: BENCH_PROFILE_ID,
          period: 'all',
        }),
        TIMEOUT_MEASURE_MS,
        'measureChannel',
      );
      if (!measure.ok) {
        throw new Error(`trend/series отклонён в прогоне ${i + 1} — прогон нечестен`);
      }
      channelRunsMs.push(measure.ms);
    }

    // (4) Замер B: медиана прогонов рендера (каждый — холодное монтирование).
    const renderRunsMs = [];
    for (let i = 0; i < runs; i += 1) {
      renderRunsMs.push(await measureRenderRun(window));
    }

    const electronVersion = await app.evaluate(() => process.versions.electron);
    const json = buildBenchJson({
      count,
      period: 'all',
      mode: series.mode,
      channelRunsMs,
      renderRunsMs,
      thresholds,
      machine: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        platform: os.platform(),
        nodeVersion: process.version,
        ...(electronVersion === undefined ? {} : { electronVersion }),
      },
      dateUtc: new Date().toISOString(),
    });
    const text = buildBenchText(json);

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

/** CLI (прецедент size-audit.mjs): флаги --count/--runs/--out-dir/--gate-*-ms/--json. */
const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = argv[1] === undefined ? undefined : resolve(argv[1]);
if (invokedPath === scriptPath) {
  let cliCount;
  let cliRuns;
  let cliOutDir;
  let cliGateChannelMs;
  let cliGateRenderMs;
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
    else if (flag === '--gate-channel-ms') cliGateChannelMs = Number(next());
    else if (flag === '--gate-render-ms') cliGateRenderMs = Number(next());
    else if (flag === '--json') cliJson = true;
    else {
      console.error(`неизвестный флаг: ${String(flag)}`);
      console.error('usage: pnpm bench:chart [--count N] [--runs N] [--out-dir DIR] [--gate-channel-ms N] [--gate-render-ms N] [--json]');
      exit(2);
    }
  }
  try {
    const result = await benchChartRun({
      ...(cliCount === undefined ? {} : { count: cliCount }),
      ...(cliRuns === undefined ? {} : { runs: cliRuns }),
      ...(cliOutDir === undefined ? {} : { outDir: cliOutDir }),
      ...(cliGateChannelMs === undefined ? {} : { gateChannelMs: cliGateChannelMs }),
      ...(cliGateRenderMs === undefined ? {} : { gateRenderMs: cliGateRenderMs }),
    });
    console.log(cliJson ? JSON.stringify(result.json, null, 2) : result.text);
    console.error(`report: ${result.reportPath}`);
    exit(result.exitCode);
  } catch (error) {
    console.error(`bench:chart: среда/прогон сломаны — exit 2: ${String(error)}`);
    exit(2);
  }
}
