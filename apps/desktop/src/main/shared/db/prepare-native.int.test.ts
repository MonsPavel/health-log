/**
 * TASK-022 §19: интеграционный тест скрипта prepare-native — выполняется и
 * идемпотентен (второй запуск — no-op, проверка хешем нативного бинарника).
 *
 * Скрипт (apps/desktop/scripts/prepare-native.sh) — каноническая точка сборки
 * SQLCipher-стека (§5/§24): smoke-тест модуля под текущим node, при провале —
 * пересборка/prebuild. Идемпотентность: при рабочем стеке скрипт НЕ трогает
 * бинарник → sha256 до/после двух запусков совпадает, оба запуска exit 0.
 *
 * Среда: тест вызывает bash (Git Bash на Windows, §22 — целевая платформа);
 * если bash недоступен — тест пропускается (окружение без bash не может
 * выполнить скрипт, это не провал контракта).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Каталог пакета @hl/desktop (тест лежит в src/main/shared/db — 4 уровня вверх). */
const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** Канонический скрипт подготовки нативного стека (§5). */
const SCRIPT = join(DESKTOP_ROOT, 'scripts', 'prepare-native.sh');

/** bash доступен? (Windows: Git Bash в PATH; Linux/macOS: системный bash). */
const bashAvailable = (): boolean => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Каталог нативного модуля (резолв через package.json — работает и в pnpm-сторе). */
const moduleRoot = (): string => {
  const req = createRequire(join(DESKTOP_ROOT, 'package.json'));
  return dirname(req.resolve('better-sqlite3-multiple-ciphers/package.json'));
};

/** Находит нативный бинарник (.node) в каталоге модуля (build/ или prebuilds/). */
const findNativeBinary = (dir: string): string => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findNativeBinary(full);
      if (found !== '') {
        return found;
      }
    } else if (entry.endsWith('.node')) {
      return full;
    }
  }
  return '';
};

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe.skipIf(!bashAvailable())('prepare-native: идемпотентность (TASK-022 §19/§24)', () => {
  it('скрипт существует (§6)', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('два запуска — exit 0; бинарник не меняется (no-op, проверка хешем §19)', () => {
    const binary = findNativeBinary(moduleRoot());
    expect(binary, 'нативный бинарник .node найден в каталоге модуля').not.toBe('');

    const hashBefore = sha256(binary);
    const first = execFileSync('bash', [SCRIPT], { cwd: DESKTOP_ROOT, encoding: 'utf8' });
    expect(first).toBeDefined();
    const hashAfterFirst = sha256(binary);
    expect(hashAfterFirst).toBe(hashBefore);

    execFileSync('bash', [SCRIPT], { cwd: DESKTOP_ROOT, encoding: 'utf8' });
    expect(sha256(binary)).toBe(hashBefore);
  });
});
