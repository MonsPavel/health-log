/**
 * TASK-069 §19/§20: интеграционный smoke bench PDF на 100 записях — проверка
 * МЕХАНИКИ (запуск bench-режима, сид каналом, полный путь report/pdf с bench-веткой
 * saver-а, отчёт, гейты) без 2–3-минутного полного прогона 5k (§15). Два сценария:
 *  1. CLI bench на 100 записях (runs 1) → exit 0, отчёт-файл создан: тайминги
 *     (медиана/мин/макс), размер PDF, count (§20 AC4); длина smoke ≤15 с (§19 —
 *     честный замер spawn-стены).
 *  2. Гейт-тест (§20 AC2): подстановка порога --gate-ms 1 → медиана > порога →
 *     exit 1, отчёт записан, gateOk=false, exitCode=1.
 *
 * Auto-save §20 AC3 («пишет в tmp, диалог не открывается») — юнит-тест
 * file-saver.test.ts (мок electron без диалога, файл в <HL_TEST_USER_DATA>/bench-saves);
 * здесь прогон 1 косвенно подтверждает: откройся диалог — прогон повис бы и упал
 * бы по таймауту (exit 2), а не вернул exit 0.
 *
 * Прогоны идут реальным CLI (child_process, root: tsx — devDependency) — проверяется
 * вся механика входа, включая коды возврата (прецедент bench-smoke.spec.ts 062).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/** Корень монорепо (spec: apps/desktop/tests/e2e/* → четыре уровня вверх). */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/** Вход bench-скрипта (CLI прогонов 1–2). */
const BENCH_SCRIPT = 'tools/scripts/bench-pdf.mjs';

/** §19: бюджет быстрого smoke (spawn целиком, без сборки). */
const SMOKE_BUDGET_MS = 15_000;

/** Запуск bench CLI: spawn node --import tsx (devDependency корня, §6). */
function runBenchCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--import', 'tsx', BENCH_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Единственный *.json в каталоге отчётов прогона (механика §5 шаг 5). */
function readReportJson(outDir: string): Record<string, unknown> {
  const files = readdirSync(outDir).filter((name) => name.endsWith('.json'));
  expect(files, 'отчёт-файл создан в out-dir').toHaveLength(1);
  return JSON.parse(readFileSync(join(outDir, files[0]!), 'utf8')) as Record<string, unknown>;
}

test.describe('TASK-069 smoke bench pdf (100 записей)', () => {
  test('CLI на 100 записях → exit 0, отчёт: медиана/мин/макс, размер PDF, count, ≤15 с (§19/§20 AC4)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hl-bench-pdf-report-'));
    try {
      const startedAt = Date.now();
      const result = runBenchCli(['--count', '100', '--runs', '1', '--out-dir', outDir]);
      const wallMs = Date.now() - startedAt;

      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      // §19: быстрый smoke ≤15 с — сам прогон, без сборки (она — предпосылка).
      expect(wallMs).toBeLessThanOrEqual(SMOKE_BUDGET_MS);

      const report = readReportJson(outDir);
      expect(report['task']).toBe('TASK-069');
      expect(report['count']).toBe(100);
      expect(report['period']).toBe('all');
      expect(report['exitCode']).toBe(0);
      // §20 AC4: медиана/мин/макс, размер PDF, count записей.
      expect(report['timings']).toMatchObject({
        medianMs: expect.any(Number),
        minMs: expect.any(Number),
        maxMs: expect.any(Number),
      });
      expect(report['file']).toMatchObject({
        medianBytes: expect.any(Number),
        minBytes: expect.any(Number),
        maxBytes: expect.any(Number),
      });
      expect(report['gateOk']).toBe(true);
      expect(result.stdout).toContain('verdict: PASS');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('§20 AC2: подстановка порога 1 мс → exit 1 с отчётом — гейт работает', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hl-bench-pdf-report-'));
    try {
      const result = runBenchCli([
        '--count',
        '100',
        '--runs',
        '1',
        '--out-dir',
        outDir,
        '--gate-ms',
        '1',
      ]);

      expect(result.status, 'гейт валит процесс: exit 1').toBe(1);
      expect(existsSync(outDir)).toBe(true);
      const report = readReportJson(outDir);
      expect(report['exitCode']).toBe(1);
      expect(report['gateOk']).toBe(false);
      expect(result.stdout).toContain('FAIL');
      expect(result.stdout).toContain('median gate');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
