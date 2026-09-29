// TASK-067 §19: юниты скрипта копирования шрифтов отчёта в dist (desktop-scripts
// проект; прецедент check-size TASK-034). tmp-каталоги — mkdtemp(os.tmpdir()), §13.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { planReportAssets, run } from './copy-report-assets.mjs';

test('planReportAssets: три ассета — Roboto Regular/Bold + OFL', () => {
  const plan = planReportAssets('SRC', 'OUT');
  assert.deepEqual(
    plan.map((step) => step.name),
    ['Roboto-Regular.ttf', 'Roboto-Bold.ttf', 'OFL.txt'],
  );
  assert.equal(plan[0].from, join('SRC', 'Roboto-Regular.ttf'));
  assert.equal(plan[0].to, join('OUT', 'Roboto-Regular.ttf'));
});

test('run: копирует шрифты в целевой каталог (recursive)', () => {
  const src = mkdtempSync(join(tmpdir(), 'hl-assets-src-'));
  const out = mkdtempSync(join(tmpdir(), 'hl-assets-out-'));
  try {
    writeFileSync(join(src, 'Roboto-Regular.ttf'), 'ttf-regular');
    writeFileSync(join(src, 'Roboto-Bold.ttf'), 'ttf-bold');
    writeFileSync(join(src, 'OFL.txt'), 'license');
    run({ sourceDir: src, outDir: out });
    assert.equal(existsSync(join(out, 'Roboto-Regular.ttf')), true);
    assert.equal(existsSync(join(out, 'Roboto-Bold.ttf')), true);
    assert.equal(existsSync(join(out, 'OFL.txt')), true);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('run: отсутствие файла шрифта — отказ до копирования (fail-fast)', () => {
  const src = mkdtempSync(join(tmpdir(), 'hl-assets-src2-'));
  const out = mkdtempSync(join(tmpdir(), 'hl-assets-out2-'));
  try {
    writeFileSync(join(src, 'Roboto-Regular.ttf'), 'ttf');
    assert.throws(() => run({ sourceDir: src, outDir: out }), /нет файла шрифта/);
    // Ничего не скопировано: план проверяется целиком до cpSync.
    assert.equal(existsSync(join(out, 'Roboto-Regular.ttf')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
