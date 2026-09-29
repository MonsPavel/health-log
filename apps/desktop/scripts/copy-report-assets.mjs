/**
 * TASK-067 §6/§9: копирование ассетов отчёта (шрифты Roboto OFL) в dist рядом
 * с собранным report-document.js — Font.register читает их относительно модуля
 * (import.meta.url). tsc .ttf не копирует; electron-builder пакует dist/main
 * целиком (asar), поэтому шаг входит в build (apps/desktop package.json).
 */
import { cpSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(desktopRoot, 'src/main/modules/reporting/adapters/pdf/fonts');
const outDir = join(desktopRoot, 'dist/main/modules/reporting/adapters/pdf/fonts');

/**
 * План копирования (чистая функция — юнит §19 desktop-scripts): список
 * (относительный путь, байты) шрифтов-ассетов отчёта.
 */
export function planReportAssets(sourceDir, outDir) {
  const files = ['Roboto-Regular.ttf', 'Roboto-Bold.ttf', 'OFL.txt'];
  return files.map((name) => ({ from: join(sourceDir, name), to: join(outDir, name), name }));
}

export function run({ sourceDir: srcDir = sourceDir, outDir: dstDir = outDir } = {}) {
  if (!existsSync(srcDir)) {
    throw new Error(`copy-report-assets: нет каталога исходных шрифтов: ${srcDir}`);
  }
  const plan = planReportAssets(srcDir, dstDir);
  for (const step of plan) {
    if (!existsSync(step.from)) {
      throw new Error(`copy-report-assets: нет файла шрифта: ${step.name}`);
    }
    statSync(step.from);
  }
  cpSync(srcDir, dstDir, { recursive: true });
  console.log(`copy-report-assets: ${plan.map((step) => step.name).join(', ')} -> dist`);
}

// Запуск напрямую (pnpm build) — при импорте из тестов ничего не делает.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
