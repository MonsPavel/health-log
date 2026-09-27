/**
 * TASK-036: скрипт аудита размера установщика — гейт бюджета D1a/NFR-5 (лимит
 * 200 МБ, warn-порог 180 МБ). Замеряет .exe-установщик и win-unpacked в
 * release-каталоге, строит отчёт: компоненты (§13: locales, *.node,
 * dist-renderer, dist-main, resources) + топ-10 крупнейших файлов + вердикт
 * с рекомендациями. Запуск: `pnpm size:audit --dist <release-каталог>`
 * (вручную/на теге; в PR-CI не входит — сборка тяжёлая, гейт подключает TASK-105).
 *
 * Коды возврата (§13): 0 — в пределах лимита (warn-зона не валит гейт, §20:
 * «180–200 → warning-строка»); 1 — превышение (гейт D1a); 2 — каталог не найден
 * / не release-каталог / вызов без --dist (ошибка вызова).
 *
 * Гейт считается по установщику (§3: ранний сигнал — установщик >180 МБ;
 * §24: реальный прогон завершается exit 0), а при его отсутствии — по
 * win-unpacked. win-unpacked всегда замеряется и попадает в отчёт справочно:
 * распакованная сборка NSIS-несжата и закономерно крупнее установщика
 * (прецедент TASK-034: установщик 120 МБ при win-unpacked 443 МБ).
 *
 * Зависимостей нет (node:fs + рекурсивный обход, §4). Отчёт — английский
 * (§16: dev-инструмент). Расчёты — чистые функции (bytesToMb/evaluateGate/
 * classifyComponent/groupByComponent/topFiles/buildReport/buildJson), ФС —
 * отдельно (walkFiles/findArtifacts/run) — юнит-тесты §19 без реальной сборки
 * (size-audit.test.mjs).
 */
import { realpathSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

/** Мегабайт в отчёте: 1 МБ = 2^20 байт (традиция Windows-проводника). */
export const MB = 1024 ** 2;

/** Лимит размера установщика (§13/NFR-5-D1a): константа LIMIT_MB = 200. */
export const LIMIT_MB = 200;

/** Warn-порог «близко к лимиту» (§13): зона предупреждения 180–200 МБ. */
export const WARN_MB = 180;

/** Размер топа крупнейших файлов в отчёте (§5: топ-10). */
export const TOP_N = 10;

/** Имя установщика electron-builder/NSIS: «<productName> Setup <version>.exe». */
export const INSTALLER_PATTERN = /^.+ Setup .+\.exe$/i;

/** Имя файла текстового отчёта в каталоге dist (§24: «отчёт создан»). */
export const REPORT_FILENAME = 'size-audit-report.txt';

/** Байты → МБ с одним десятичным знаком (формат отчёта). */
export function bytesToMb(bytes) {
  return Math.round((bytes / MB) * 10) / 10;
}

/**
 * Пороговое решение (§13/§19 — чистая функция): exceeded — строго больше лимита
 * (гейт, exit 1); warn — строго больше warn-порога и до лимита включительно
 * (зона 180–200, предупреждение без провала); иначе ok.
 */
export function evaluateGate(bytes, limitMb = LIMIT_MB, warnMb = WARN_MB) {
  if (bytes > limitMb * MB) {
    return 'exceeded';
  }
  if (bytes > warnMb * MB) {
    return 'warn';
  }
  return 'ok';
}

/**
 * Компонент файла по относительному пути (§13). Приоритет: нативный модуль —
 * важнее каталога-обёртки; бандлы dist-main/dist-renderer (внутри asar их нет,
 * но группировка определена на случай asar:false/распаковки); locales —
 * Electron-локали; корневые файлы win-unpacked — Electron runtime (ручная
 * проверка §24: крупнейший компонент — Electron runtime, ожидаемо ~70%);
 * resources — код приложения (app.asar, распакованные нативные деревья).
 */
export function classifyComponent(relPath) {
  const parts = relPath.split(/[\\/]/);
  if (parts.some((part) => part.endsWith('.node'))) {
    return 'native (*.node)';
  }
  if (parts.includes('dist-main')) {
    return 'dist-main (main bundle)';
  }
  if (parts.includes('dist-renderer')) {
    return 'dist-renderer (renderer bundle)';
  }
  if (parts.includes('locales')) {
    return 'locales (Electron)';
  }
  if (parts.length === 1) {
    return 'electron-runtime (root files)';
  }
  if (parts.includes('resources')) {
    return 'resources';
  }
  return 'other';
}

/**
 * Группировка файлов по компонентам (§13): сумма байт, МБ и доля группы
 * в процентах от общего размера; сортировка по убыванию.
 */
export function groupByComponent(files, totalBytes) {
  const sums = new Map();
  for (const file of files) {
    const name = classifyComponent(file.relPath);
    sums.set(name, (sums.get(name) ?? 0) + file.bytes);
  }
  return [...sums]
    .map(([name, bytes]) => ({
      name,
      bytes,
      mb: bytesToMb(bytes),
      sharePct: totalBytes === 0 ? 0 : Math.round((bytes / totalBytes) * 1000) / 10,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Топ-N файлов по размеру (детерминированно: при равенстве — по relPath). */
export function topFiles(files, n = TOP_N) {
  return [...files]
    .sort((a, b) => b.bytes - a.bytes || a.relPath.localeCompare(b.relPath))
    .slice(0, n);
}

/** Рекурсивный обход каталога: {path, relPath, bytes} каждого файла. */
export async function walkFiles(dir, rootDir = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath, rootDir)));
    } else if (entry.isFile()) {
      const { size } = await stat(fullPath);
      files.push({ path: fullPath, relPath: relative(rootDir, fullPath), bytes: size });
    }
  }
  return files;
}

/**
 * Артефакты в release-каталоге: установщик «* Setup *.exe» в корне и
 * win-unpacked. Также принимается сам win-unpacked, переданный как --dist
 * (формат примера §20): распознаётся по корневому *.exe + каталогу resources.
 */
export async function findArtifacts(distDir) {
  const entries = await readdir(distDir, { withFileTypes: true });
  const installer = entries.find((entry) => entry.isFile() && INSTALLER_PATTERN.test(entry.name));
  const hasUnpackedSubdir = entries.some(
    (entry) => entry.isDirectory() && entry.name === 'win-unpacked',
  );
  const isUnpackedItself =
    entries.some((entry) => entry.isDirectory() && entry.name === 'resources') &&
    entries.some((entry) => entry.isFile() && /\.exe$/i.test(entry.name));
  return {
    installerPath: installer === undefined ? undefined : join(distDir, installer.name),
    unpackedPath: hasUnpackedSubdir
      ? join(distDir, 'win-unpacked')
      : isUnpackedItself
        ? distDir
        : undefined,
  };
}

/** Статичные рекомендации по компонентам (§2: «отчёт … с рекомендациями»). */
const COMPONENT_ADVICE = new Map([
  [
    'electron-runtime (root files)',
    'Electron runtime dominates — expected for D1a (spec §24); shrink only via Electron upgrade or pruning',
  ],
  [
    'locales (Electron)',
    'prune unused Electron locales (.pak) in afterPack if the budget tightens',
  ],
  [
    'native (*.node)',
    'keep the native module prebuilt and single-copy (ADR-0002); check it is not duplicated',
  ],
  [
    'dist-main (main bundle)',
    'inspect the main bundle with source-map-explorer when it grows (spec §23)',
  ],
  [
    'dist-renderer (renderer bundle)',
    'inspect the renderer bundle with source-map-explorer when it grows (spec §23)',
  ],
  ['resources', 'check app.asar and extraResources for accidental bulk (spec §23)'],
  ['other', 'unclassified files — review the top list above'],
]);

/** Строка вердикта по пороговому решению (§5/§13/§20, ранний сигнал §3, §22). */
function verdictLine({ subject, mb, verdict, limitMb, warnMb }) {
  if (verdict === 'exceeded') {
    return `verdict: EXCEEDED — ${subject} ${mb} MB is over the ${limitMb} MB limit — D1a review triggered: decide Electron vs Tauri now (spec §22)`;
  }
  if (verdict === 'warn') {
    return `verdict: WARNING — ${subject} ${mb} MB is close to the ${limitMb} MB limit (warning threshold ${warnMb} MB) — re-check every release (spec §3)`;
  }
  return `verdict: OK — ${subject} ${mb} MB is within the ${limitMb} MB limit (warning threshold ${warnMb} MB)`;
}

/**
 * Человекочитаемый отчёт (§5: таблица + вердикт; английский, §16). Вход —
 * measurement из run(); чистая функция (без ФС) — тестируется на фикстурах §19.
 */
export function buildReport(measurement) {
  const {
    distDir,
    limitMb,
    warnMb,
    installer,
    unpacked,
    gate,
    components,
    topFiles: top,
  } = measurement;
  const lines = [
    `TASK-036: size audit (NFR-5/D1a budget, limit ${limitMb} MB)`,
    `dist: ${distDir}`,
  ];

  lines.push('', 'measured:');
  lines.push(
    installer === undefined
      ? '  installer: not found (build it first: pnpm dist)'
      : `  installer: ${installer.mb} MB (${installer.path})`,
  );
  lines.push(
    unpacked === undefined
      ? '  win-unpacked: not found'
      : gate.subject === 'installer'
        ? `  win-unpacked: ${unpacked.mb} MB (informational; NSIS compresses — the gate is the installer)`
        : `  win-unpacked: ${unpacked.mb} MB (gate subject — installer not found)`,
  );
  lines.push(
    `  gate: ${gate.subject} ${gate.mb} MB → ${gate.verdict} (limit ${limitMb} MB, warn ${warnMb} MB)`,
  );

  if (components.length > 0) {
    lines.push('', 'components of win-unpacked (grouped per spec §13):');
    lines.push(`  ${'component'.padEnd(32)}${'size'.padStart(10)}${'share'.padStart(9)}`);
    for (const group of components) {
      lines.push(
        `  ${group.name.padEnd(32)}${`${group.mb.toFixed(1)} MB`.padStart(10)}${`${group.sharePct}%`.padStart(9)}`,
      );
    }
  }

  if (top.length > 0) {
    lines.push('', `top 10 largest files (of win-unpacked):`);
    for (const [index, file] of top.entries()) {
      lines.push(
        `  ${`${index + 1}.`.padStart(4)} ${file.relPath.padEnd(60)}${`${file.mb.toFixed(1)} MB`.padStart(10)}  ${file.component}`,
      );
    }
  }

  lines.push(
    '',
    verdictLine({ subject: gate.subject, mb: gate.mb, verdict: gate.verdict, limitMb, warnMb }),
  );

  lines.push('', 'recommendations:');
  for (const group of components.slice(0, 3)) {
    lines.push(
      `  - ${group.name} (${group.mb.toFixed(1)} MB): ${COMPONENT_ADVICE.get(group.name) ?? COMPONENT_ADVICE.get('other')}`,
    );
  }
  if (gate.verdict === 'exceeded') {
    lines.push('  - overall: LIMIT EXCEEDED — D1a review triggered now, before release (spec §22)');
  } else if (gate.verdict === 'warn') {
    lines.push('  - overall: WARNING zone — re-check the budget at every release (spec §3)');
  } else {
    lines.push('  - overall: within budget — no action needed (re-run after each release)');
  }

  return lines.join('\n');
}

/**
 * JSON-режим (--json, §20: вывод парсится JSON.parse в CI TASK-105): тот же
 * measurement в машиночитаемом виде; error-прогон тоже сериализуем.
 */
export function buildJson(measurement) {
  return {
    distDir: measurement.distDir,
    limitMb: measurement.limitMb ?? LIMIT_MB,
    warnMb: measurement.warnMb ?? WARN_MB,
    gate: measurement.gate ?? null,
    installer: measurement.installer ?? null,
    unpacked: measurement.unpacked ?? null,
    components: measurement.components ?? [],
    topFiles: measurement.topFiles ?? [],
    exitCode: measurement.exitCode,
    ...(measurement.error === undefined ? {} : { error: measurement.error }),
  };
}

/**
 * Полный прогон (§5): артефакты → замер (установщик — stat, win-unpacked —
 * один рекурсивный обход ≤5 с, §15) → отчёт-файл в каталоге dist (§24: «отчёт
 * создан») → код возврата §13. Опции limitMb/warnMb — точки ввода тестов §19.
 */
export async function run(options = {}) {
  const distDir = resolve(options.distDir ?? '.');
  const limitMb = options.limitMb ?? LIMIT_MB;
  const warnMb = options.warnMb ?? WARN_MB;

  let distInfo;
  try {
    distInfo = await stat(distDir);
  } catch {
    return { exitCode: 2, error: `dist directory not found: ${distDir}` };
  }
  if (!distInfo.isDirectory()) {
    return { exitCode: 2, error: `dist path is not a directory: ${distDir}` };
  }

  const { installerPath, unpackedPath } = await findArtifacts(distDir);
  if (installerPath === undefined && unpackedPath === undefined) {
    return {
      exitCode: 2,
      error: `not a release directory (no * Setup *.exe installer and no win-unpacked): ${distDir}`,
    };
  }

  const installer =
    installerPath === undefined
      ? undefined
      : await stat(installerPath).then(({ size }) => ({
          path: installerPath,
          bytes: size,
          mb: bytesToMb(size),
        }));

  const files = unpackedPath === undefined ? [] : await walkFiles(unpackedPath);
  const unpackedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const unpacked =
    unpackedPath === undefined
      ? undefined
      : { path: unpackedPath, bytes: unpackedBytes, mb: bytesToMb(unpackedBytes) };

  // Гейт — по установщику (§3/§24); без него — по единственному замеренному
  // артефакту (кейс §20: --dist указывает на сам win-unpacked).
  const gateSubject = installer === undefined ? 'win-unpacked' : 'installer';
  const gateBytes = installer === undefined ? unpacked.bytes : installer.bytes;
  const verdict = evaluateGate(gateBytes, limitMb, warnMb);
  const exitCode = verdict === 'exceeded' ? 1 : 0;

  const measurement = {
    distDir,
    limitMb,
    warnMb,
    installer,
    unpacked,
    gate: { subject: gateSubject, bytes: gateBytes, mb: bytesToMb(gateBytes), verdict, exitCode },
    components: groupByComponent(files, unpackedBytes),
    topFiles: topFiles(files).map((file) => ({
      relPath: file.relPath,
      bytes: file.bytes,
      mb: bytesToMb(file.bytes),
      component: classifyComponent(file.relPath),
    })),
    exitCode,
  };

  const report = buildReport(measurement);
  await writeFile(join(distDir, REPORT_FILENAME), `${report}\n`, 'utf8');
  return { exitCode, report, json: measurement };
}

/** CLI-вызов (node tools/scripts/size-audit.mjs): разбор флагов --dist/--json. */
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const invokedPath = argv[1] === undefined ? undefined : realpathSync(argv[1]);
if (invokedPath === scriptPath) {
  let cliDist;
  let cliJson = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dist') {
      cliDist = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') {
      cliJson = true;
    }
  }
  if (cliDist === undefined) {
    console.error('usage: node tools/scripts/size-audit.mjs --dist <release-dir> [--json]');
    exit(2);
  }
  const result = await run({ distDir: cliDist });
  if (cliJson) {
    console.log(
      JSON.stringify(
        buildJson(
          result.json ?? {
            distDir: resolve(cliDist),
            exitCode: result.exitCode,
            error: result.error,
          },
        ),
        null,
        2,
      ),
    );
  } else if (result.report !== undefined) {
    console.log(result.report);
  } else {
    console.error(result.error);
  }
  exit(result.exitCode);
}
