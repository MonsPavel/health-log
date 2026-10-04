/**
 * TASK-111: bench холодного старта packaged-сборки (§5/§2 NFR-4: старт ≤3 с) —
 * воспроизводимый прогон честной пользовательской метрики:
 *  (1) packaged exe (dist/win-unpacked/«Health Log.exe», продуктовая сборка
 *      electron-builder 034) запускается через e2e-хелпер (launchApp 035,
 *      опция executablePath TASK-111) с изолированным tmp-userData
 *      (HL_TEST_USER_DATA — resolveUserDataPath работает и в packaged, §9 035);
 *  (2) замер wall-time «вызов launch (spawn процесса) → ПЕРВЫЙ ОСМЫСЛЕННЫЙ КАДР» —
 *      появление контента дефолтного маршрута /dashboard на свежем профиле
 *      (data-testid="dashboard-welcome", приветственный экран пустого дневника
 *      061): конец всей честной цепочки старта — RecoveryGate → LockGate →
 *      AppRouter → React Query-запросы сводки. t0 — перед _electron.launch
 *      (включает сотни мс проводки Playwright — отмечено в методике отчёта);
 *  (3) повтор ×5 (§5: «старт packaged ×5 медиана»), каждый — свежий процесс и
 *      свежий tmp-userData (холодный старт, single-instance lock не мешает);
 *  (4) медиана — честность замера (§13 062, не минимум);
 *  (5) отчёт: JSON (tools/bench-results/<date>.json, §18, в .gitignore) + текст
 *      в stdout; гейт: медиана ≤3000 мс (NFR-4) → exit 0/1; ошибка среды → exit 2.
 *
 * ОЖИДАНИЕ (§5 «Не включено»): замер на dev-машине, не на стенде железа A —
 * конфигурация фиксируется в отчёте (машина-контекст §13 062); вердикт цели —
 * NOTE/PASS-решение за сводным отчётом docs/release/perf-mvp.md.
 *
 * Запуск: `pnpm perf:startup [--runs N] [--exe PATH] [--out-dir DIR] [--gate-ms N]
 * [--json]`. Коды возврата: 0 — гейт пройден; 1 — гейт превышен; 2 — ошибка
 * среды/вызова (нет exe, таймаут кадра). ПРЕДПОСЫЛКА: packaged-сборка
 * (`pnpm --filter @hl/desktop dist`) — exe существует.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import {
  STARTUP_GATE_MS,
  STARTUP_RUNS_DEFAULT,
  buildStartupBenchJson,
  buildStartupBenchText,
} from './lib/perf-startup.js';
import { closeApp, launchApp } from '../../apps/desktop/tests/e2e/helpers/launch.js';

/** packaged exe по умолчанию — продукт electron-builder 034 (§5: win-unpacked). */
const DEFAULT_EXE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'desktop',
  'dist',
  'win-unpacked',
  'Health Log.exe',
);

/** Первый осмысленный кадр (§4): контент /dashboard на свежем профиле (061). */
const MEANINGFUL_FRAME_SELECTOR = '[data-testid="dashboard-welcome"]';

/** Таймаут ожидания кадра одного прогона, мс (гейт 3 с оценивается отдельно). */
const TIMEOUT_FRAME_MS = 60_000;

/**
 * Один прогон (§5 шаг 2): свежий tmp-userData → launch packaged exe → ожидание
 * первого осмысленного кадра → wall-time + версия Electron сборки (machine-контекст).
 * Отказ запуска/кадра — исключение (прогон невалиден, exit 2 решает CLI).
 */
async function measureStartupRun(exePath) {
  const userData = await mkdtemp(join(tmpdir(), 'hl-perf-startup-'));
  let app;
  try {
    const startedAtMs = performance.now();
    app = await launchApp({ userData, executablePath: exePath });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForSelector(MEANINGFUL_FRAME_SELECTOR, {
      state: 'visible',
      timeout: TIMEOUT_FRAME_MS,
    });
    const ms = performance.now() - startedAtMs;
    const electronVersion = await app.evaluate(() => process.versions.electron);
    return { ms, electronVersion };
  } finally {
    if (app !== undefined) {
      await closeApp(app).catch(() => undefined);
    }
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Параметры прогона (§5 шаги 1–5 + точки ввода smoke/ручных прогонов). */
export async function perfStartupRun(options = {}) {
  const runs = options.runs ?? STARTUP_RUNS_DEFAULT;
  const outDir = resolve(
    options.outDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'bench-results'),
  );
  const exePath = resolve(options.exe ?? DEFAULT_EXE);
  const thresholdMs = options.gateMs ?? STARTUP_GATE_MS;

  // ФС-проверка exe ДО прогонов: нет сборки → exit 2 (CLI), а не гейт-провал.
  const { access } = await import('node:fs/promises');
  await access(exePath);

  const runsMs = [];
  let electronVersion;
  for (let i = 0; i < runs; i += 1) {
    const run = await measureStartupRun(exePath);
    runsMs.push(run.ms);
    // Версия Electron замеренной сборки (из последнего прогона; machine-контекст).
    electronVersion = run.electronVersion;
  }

  const json = buildStartupBenchJson({
    exe: basename(exePath),
    runsMs,
    thresholdMs,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      platform: os.platform(),
      nodeVersion: process.version,
      ...(electronVersion === undefined ? {} : { electronVersion }),
    },
    dateUtc: new Date().toISOString(),
  });
  const text = buildStartupBenchText(json);

  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, `${json.dateUtc.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(reportPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  return { exitCode: json.exitCode, json, text, reportPath };
}

/** CLI (прецедент bench-pdf.mjs): флаги --runs/--exe/--out-dir/--gate-ms/--json. */
const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = argv[1] === undefined ? undefined : resolve(argv[1]);
if (invokedPath === scriptPath) {
  let cliRuns;
  let cliExe;
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
    if (flag === '--runs') cliRuns = Number(next());
    else if (flag === '--exe') cliExe = next();
    else if (flag === '--out-dir') cliOutDir = next();
    else if (flag === '--gate-ms') cliGateMs = Number(next());
    else if (flag === '--json') cliJson = true;
    else {
      console.error(`неизвестный флаг: ${String(flag)}`);
      console.error(
        'usage: pnpm perf:startup [--runs N] [--exe PATH] [--out-dir DIR] [--gate-ms N] [--json]',
      );
      exit(2);
    }
  }
  try {
    const result = await perfStartupRun({
      ...(cliRuns === undefined ? {} : { runs: cliRuns }),
      ...(cliExe === undefined ? {} : { exe: cliExe }),
      ...(cliOutDir === undefined ? {} : { outDir: cliOutDir }),
      ...(cliGateMs === undefined ? {} : { gateMs: cliGateMs }),
    });
    console.log(cliJson ? JSON.stringify(result.json, null, 2) : result.text);
    console.error(`report: ${result.reportPath}`);
    exit(result.exitCode);
  } catch (error) {
    console.error(`perf:startup: среда/прогон сломаны — exit 2: ${String(error)}`);
    exit(2);
  }
}
