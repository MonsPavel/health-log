/**
 * TASK-034 §24: скрипт аудита размера packaged-артефактов — проверяет размер
 * установщика и win-unpacked, пишет отчёт `dist/size-report.txt`, код возврата
 * отражает вердикт.
 *
 * Запуск: `node scripts/check-size.mjs` (последний шаг скрипта `dist`, §6) или
 * вручную после сборки. Опции CLI: `--limit <МБ>` (по умолчанию 200 — NFR-5/D1a),
 * `--dist <каталог>` (по умолчанию `../dist`).
 *
 * Гейт (§20): «Установщик ≤200 МБ (первичный замер; гейт — TASK-036)» — здесь
 * проверка и отчёт; превышение = exit 1 (громкий сбой, а не тихая деградация),
 * TASK-036 включит этот же порог в свой конвейер.
 *
 * Чистые функции (bytesToMb/measurePath/findArtifacts/buildReport) покрыты
 * юнит-тестами check-size.test.mjs (§19).
 */
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

/** Мегабайт в отчёте: 1 МБ = 2^20 байт (традиция Windows-проводника). */
export const MB = 1024 ** 2;

/** Лимит размера установщика (§20/NFR-5-D1a); гейт — TASK-036. */
export const SIZE_LIMIT_MB = 200;

/** Имя файла отчёта в каталоге dist (§24: «скрипт проверяет и пишет отчёт»). */
export const REPORT_FILENAME = 'size-report.txt';

/** Байты → МБ с одним десятичным знаком (формат отчёта). */
export function bytesToMb(bytes) {
  return Math.round((bytes / MB) * 10) / 10;
}

/** Размер пути: файл — свой размер; каталог — рекурсивная сумма файлов. */
export async function measurePath(path) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await measurePath(join(path, entry.name));
  }
  return total;
}

/**
 * Артефакты сборки в каталоге dist (§20): установщик `* Setup *.exe` в корне dist
 * (имя — «<productName> Setup <version>.exe», productName из electron-builder.yml)
 * и каталог win-unpacked. Отсутствие установщика — undefined (run() фейлится).
 */
export async function findArtifacts(distDir) {
  const entries = await readdir(distDir, { withFileTypes: true });
  const installer = entries.find(
    (entry) => entry.isFile() && /^.+ Setup .+\.exe$/i.test(entry.name),
  );
  const unpacked = entries.find((entry) => entry.isDirectory() && entry.name === 'win-unpacked');
  return {
    installerPath: installer === undefined ? undefined : join(distDir, installer.name),
    unpackedPath: unpacked === undefined ? undefined : join(distDir, unpacked.name),
  };
}

/** Установщик не найден: в отчёт уходит подсказка собрать сначала (§24: dist exit 0). */
const MISSING_ARTIFACT_HINT = 'установщик не найден — сначала выполните pnpm dist (§24)';

/**
 * Текст отчёта (§24). Вердикт по установщику; win-unpacked — справочно
 * (распакованная сборка всегда крупнее установщика, лимит §20 — на установщик).
 */
export function buildReport({
  installerBytes,
  unpackedBytes,
  installerPath,
  limitMb = SIZE_LIMIT_MB,
}) {
  const lines = [`TASK-034: размер packaged-артефактов (лимит ${limitMb} МБ — NFR-5/D1a)`];
  if (installerBytes === undefined) {
    lines.push(`  ${MISSING_ARTIFACT_HINT}`);
    return lines.join('\n');
  }
  // Вердикт — по сырым байтам (та же проверка, что в run()); bytesToMb — только
  // формат отображения (округление до 0.1 МБ не должно менять вердикт на границе).
  const over = installerBytes > limitMb * MB;
  const installerMb = bytesToMb(installerBytes);
  lines.push(`  установщик: ${installerMb.toFixed(1)} МБ`);
  lines.push(
    over
      ? `  лимит ${limitMb.toFixed(1)} МБ: ПРЕВЫШЕН (${installerMb.toFixed(1)} > ${limitMb.toFixed(1)}; гейт — TASK-036)`
      : `  лимит ${limitMb.toFixed(1)} МБ: ок (первичный замер §24; гейт — TASK-036)`,
  );
  lines.push(
    unpackedBytes === undefined
      ? '  win-unpacked: не найден'
      : `  win-unpacked: ${bytesToMb(unpackedBytes).toFixed(1)} МБ`,
  );
  lines.push(`  путь установщика: ${installerPath}`);
  return lines.join('\n');
}

/**
 * Полный прогон (§24): артефакты → замер → отчёт в `<distDir>/size-report.txt` →
 * код возврата (0 — установщик в пределах лимита; 1 — нет установщика или лимит
 * превышен). Опции — точки ввода тестов (§19): distDir/limitMb переопределяемы.
 */
export async function run(options = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const distDir = resolve(options.distDir ?? join(scriptDir, '..', 'dist'));
  const limitMb = options.limitMb ?? SIZE_LIMIT_MB;

  const { installerPath, unpackedPath } = await findArtifacts(distDir);
  const installerBytes =
    installerPath === undefined ? undefined : await measurePath(installerPath);
  const unpackedBytes =
    unpackedPath === undefined ? undefined : await measurePath(unpackedPath);

  const report = buildReport({ installerBytes, unpackedBytes, installerPath, limitMb });
  await writeFile(join(distDir, REPORT_FILENAME), `${report}\n`, 'utf8');

  const ok = installerBytes !== undefined && installerBytes <= limitMb * MB;
  return ok ? 0 : 1;
}

/** CLI-вызов (node scripts/check-size.mjs): разбор флагов --limit/--dist. */
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const invokedPath = argv[1] === undefined ? undefined : realpathSync(argv[1]);
if (invokedPath === scriptPath) {
  let cliLimit = SIZE_LIMIT_MB;
  let cliDist;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--limit') {
      cliLimit = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--dist') {
      cliDist = isAbsolute(argv[i + 1]) ? argv[i + 1] : resolve(argv[i + 1]);
      i += 1;
    }
  }
  const cliCode = await run({ distDir: cliDist, limitMb: cliLimit });
  const report = await readFile(join(cliDist ?? join(dirname(scriptPath), '..', 'dist'), REPORT_FILENAME), 'utf8');
  console.log(report);
  exit(cliCode);
}
