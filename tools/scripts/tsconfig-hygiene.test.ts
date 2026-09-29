/**
 * Гигиена корневых tsconfig-ов: дубликаты ключей в JSON-конфигах — детерминированные
 * WARNING'и esbuild в каждом прогоне vitest (JSON-loader vite/esbuild читает
 * tsconfig-файлы; `Duplicate key ... in object literal [duplicate-object-key]` —
 * шум в выводе гейт-проверок и молчаливая потеря первого значения при разборе).
 *
 * Проверка ТЕМ ЖЕ движком, который печатает предупреждение (transformWithEsbuild
 * из vite → esbuild loader 'json'): предупреждений класса Duplicate key быть не
 * должно ни в одном tsconfig*.json репозитория (кроме node_modules/dist —
 * skip-список ниже; глубина 4 покрывает root, packages/*, apps/desktop).
 *
 * Гард `scanned ≥ 10`: если обход сломался и файлы не нашлись — тест падает
 * явно, а не проходит на пустом множестве (прецедент «0 тестов — не успех»).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

import { transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';

/** Корень монорепо от этого файла (tools/scripts → на 2 уровня вверх). */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Каталоги, вне которых конфигов проекта нет (зависимости/артефакты сборки). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.zcode',
  'test-results',
  '.pnpm-store',
]);

/** Все tsconfig*.json репозитория (глубина ≤4: root, packages/*, apps/desktop). */
function collectTsconfigFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) {
      return;
    }
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) {
        continue;
      }
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path, depth + 1);
      } else if (/^tsconfig.*\.json$/.test(name)) {
        found.push(path);
      }
    }
  };
  walk(REPO_ROOT, 0);
  return found.sort();
}

describe('tsconfig-конфиги — без дубликатов ключей (esbuild JSON-loader)', () => {
  it('ни один tsconfig*.json не содержит Duplicate key (шум в выводе vitest, молчаливая потеря значения)', async () => {
    const files = collectTsconfigFiles();
    // Гард обхода: конфигов в монорепо заведомо больше десяти (root + пакеты + desktop).
    expect(files.length).toBeGreaterThanOrEqual(10);

    const offenders: string[] = [];
    for (const file of files) {
      const result = await transformWithEsbuild(readFileSync(file, 'utf8'), file);
      const duplicates = result.warnings.filter((warning) =>
        warning.text.includes('Duplicate key'),
      );
      if (duplicates.length > 0) {
        offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')}: ${duplicates.map((w) => w.text).join('; ')}`);
      }
    }

    expect(offenders, 'файлы с дубликатами ключей').toEqual([]);
  });
});
