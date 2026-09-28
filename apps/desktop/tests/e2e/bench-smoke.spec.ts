/**
 * TASK-062 §19/§20: интеграционный smoke bench на 100 записях — проверка МЕХАНИКИ
 * (запуск bench-режима, сид каналом, хуки, отчёт, гейты) без 45-секундного полного
 * прогона 10k. Три сценария:
 *  1. CLI bench на 100 записях (runs 1) → exit 0, отчёт-файл создан, медианы и
 *     гейты в отчёте; длина smoke ≤10 с (§20 AC5 — честный замер spawn-стены).
 *  2. Искусственное замедление (§20 AC2: throttle в тест-варианте) — недостижимый
 *     порог --gate-channel-ms 0: ГЕЙТ-механика та же, что при реальном замедлении
 *     (медиана > порога) → exit 1, отчёт записан, gates.ok=false, exitCode=1.
 *  3. Негатив (§20 AC4): запуск БЕЗ HL_BENCH=1 — window.hl.__bench отсутствует
 *     и канал __bench/seed НЕ зарегистрирован (invoke → APP/INTERNAL, §11: гард
 *     пропускает регистрацию; логическая сторона гарда — юнит-тест bench-seed).
 *
 * Прогоны 1–2 идут реальным CLI (child_process, root: tsx — devDependency) —
 * проверяется вся механика входа, включая коды возврата (прецедент vault-real).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';

/** Корень монорепо (spec: apps/desktop/tests/e2e/* → четыре уровня вверх). */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/** Вход bench-скрипта (CLI прогонов 1–2). */
const BENCH_SCRIPT = 'tools/scripts/bench-chart.mjs';

/** §20 AC5: бюджет быстрого smoke (spawn целиком, без сборки). */
const SMOKE_BUDGET_MS = 10_000;

/** Запуск bench CLI: spawn node --import tsx (devDependency корня, §6). */
function runBenchCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--import', 'tsx', BENCH_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Единственный *.json в каталоге отчётов прогонa (путь из stderr-строки report:). */
function readReportJson(outDir: string): Record<string, unknown> {
  const files = readdirSync(outDir).filter((name) => name.endsWith('.json'));
  expect(files, 'отчёт-файл создан в out-dir').toHaveLength(1);
  return JSON.parse(readFileSync(join(outDir, files[0]!), 'utf8')) as Record<string, unknown>;
}

const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-bench-smoke-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  launch: async ({}, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (userData: string) => {
      const app = await launchApp({ userData });
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      await closeApp(app).catch(() => undefined);
    }
  },
});

test.describe('TASK-062 smoke bench (100 записей)', () => {
  test('CLI на 100 записях → exit 0, отчёт с медианами и гейтами, ≤10 с (§20 AC1-механика/AC5)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hl-bench-report-'));
    try {
      const startedAt = Date.now();
      const result = runBenchCli(['--count', '100', '--runs', '1', '--out-dir', outDir]);
      const wallMs = Date.now() - startedAt;

      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      // §20 AC5: быстрый smoke ≤10 с — сам прогон, без сборки (она — предпосылка).
      expect(wallMs).toBeLessThanOrEqual(SMOKE_BUDGET_MS);

      const report = readReportJson(outDir);
      expect(report['task']).toBe('TASK-062');
      expect(report['count']).toBe(100);
      expect(report['mode']).toBe('raw'); // 100 ≤ порога 500 — сырые точки (§2 056)
      expect(report['exitCode']).toBe(0);
      expect(report['medians'], 'медианы записаны (§20 AC1)').toMatchObject({
        channelMs: expect.any(Number),
        renderMs: expect.any(Number),
        totalMs: expect.any(Number),
      });
      expect(report['gates']).toMatchObject({ channelOk: true, renderOk: true, ok: true });
      expect(result.stdout).toContain('verdict: PASS');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('искусственное замедление (порог 0) → exit 1 с отчётом — гейт работает (§20 AC2)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hl-bench-report-'));
    try {
      const result = runBenchCli([
        '--count',
        '100',
        '--runs',
        '1',
        '--out-dir',
        outDir,
        '--gate-channel-ms',
        '0',
      ]);

      expect(result.status, 'гейт валит процесс: exit 1').toBe(1);
      expect(existsSync(outDir)).toBe(true);
      const report = readReportJson(outDir);
      expect(report['exitCode']).toBe(1);
      expect(report['gates']).toMatchObject({ channelOk: false, ok: false, renderOk: true });
      expect(result.stdout).toContain('FAIL');
      expect(result.stdout).toContain('channel gate');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('без HL_BENCH=1: __bench отсутствует, канал __bench/seed не зарегистрирован (§20 AC4)', async ({
    tmpUserData,
    launch,
  }) => {
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const probe = await window.evaluate(async () => {
      // Страница — не TS-DOM контекст: форма window.hl — локальный структурный тип.
      const host = globalThis as unknown as {
        hl?: {
          __bench?: unknown;
          invoke?: (channel: string, payload: unknown) => Promise<unknown>;
        };
      };
      const raw = (await host.hl?.invoke?.('__bench/seed', { count: 1 })) as
        { ok?: boolean; error?: { code?: string } } | undefined;
      return { hasBench: host.hl?.__bench !== undefined, seedEnvelope: raw };
    });

    // §14/§20 AC4: поверхность bench отсутствует и без флага канал неизвестен —
    // каркас отвечает APP/INTERNAL («неизвестный IPC-канал»), как любому чужому.
    expect(probe.hasBench).toBe(false);
    expect(probe.seedEnvelope?.ok).toBe(false);
    expect(probe.seedEnvelope?.error?.code).toBe('APP/INTERNAL');
  });
});
