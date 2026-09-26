/**
 * TASK-034 §19/§24: юнит-тесты скрипта аудита размера packaged-артефактов.
 *
 * Автоматизируемая часть §24 («размер артефакта ≤200 МБ — скрипт проверяет и пишет
 * отчёт»): чистые функции форматирования/подсчёта и прогон run() на tmp-каталоге
 * (fs.mkdtemp — прецедент vitest.setup.ts, §13: ФС пользователя не затрагивается).
 * Сама сборка (`pnpm dist`) — не юнит-тест: её проверяет §24 вручную/в CI.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  MB,
  REPORT_FILENAME,
  SIZE_LIMIT_MB,
  buildReport,
  bytesToMb,
  findArtifacts,
  measurePath,
  run,
} from './check-size.mjs';

/** Корень tmp-каталога тестов; удаляется после прогона (§13: без следов). */
const tmpRoots = [];

/** Новый tmp-каталог с регистрацией на очистку. */
async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('bytesToMb (формат отчёта: 1 МБ = 2^20, один десятичный знак)', () => {
  it('0 байт → 0', () => {
    expect(bytesToMb(0)).toBe(0);
  });

  it('ровно 1 МБ', () => {
    expect(bytesToMb(MB)).toBe(1);
  });

  it('дробное значение округляется до 0.1 (125941529 байт → 120.1 МБ)', () => {
    expect(bytesToMb(125_941_529)).toBe(120.1);
  });
});

describe('measurePath (файл и рекурсивный каталог)', () => {
  it('размер отдельного файла', async () => {
    const dir = await makeTmp('hl-size-file-');
    const file = join(dir, 'a.txt');
    await writeFile(file, Buffer.alloc(1234, 1));
    await expect(measurePath(file)).resolves.toBe(1234);
  });

  it('каталог: сумма по вложенным файлам (рекурсивно)', async () => {
    const dir = await makeTmp('hl-size-dir-');
    await writeFile(join(dir, 'root.bin'), Buffer.alloc(100, 1));
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'deep.bin'), Buffer.alloc(50, 1));
    await expect(measurePath(dir)).resolves.toBe(150);
  });
});

describe('findArtifacts (установщик «* Setup *.exe» + win-unpacked в каталоге dist)', () => {
  it('находит оба артефакта', async () => {
    const distDir = await makeTmp('hl-size-dist-');
    const installerPath = join(distDir, 'Health Log Setup 0.0.0.exe');
    await writeFile(installerPath, Buffer.alloc(10, 1));
    const unpackedPath = join(distDir, 'win-unpacked');
    await mkdir(unpackedPath);
    const artifacts = await findArtifacts(distDir);
    expect(artifacts.installerPath).toBe(installerPath);
    expect(artifacts.unpackedPath).toBe(unpackedPath);
  });

  it('без установщика → installerPath undefined (run() фейлится с понятной ошибкой)', async () => {
    const distDir = await makeTmp('hl-size-empty-');
    const artifacts = await findArtifacts(distDir);
    expect(artifacts.installerPath).toBeUndefined();
  });
});

describe('buildReport (текст отчёта §24)', () => {
  const base = {
    installerBytes: 125_941_529,
    unpackedBytes: 463_730_720,
    installerPath: 'D:\\out\\Health Log Setup 0.0.0.exe',
    limitMb: SIZE_LIMIT_MB,
  };

  it('в пределах лимита: строка лимита с вердиктом «ок»', () => {
    const report = buildReport(base);
    expect(report).toContain('TASK-034');
    expect(report).toContain('установщик: 120.1 МБ');
    expect(report).toContain(`лимит ${SIZE_LIMIT_MB.toFixed(1)} МБ: ок`);
    expect(report).toContain('win-unpacked: 442.2 МБ');
    expect(report).toContain(base.installerPath);
  });

  it('превышение: вердикт «ПРЕВЫШЕН» и размер лимита в тексте', () => {
    const report = buildReport({ ...base, limitMb: 100 });
    expect(report).toContain('ПРЕВЫШЕН');
    expect(report).toContain('лимит 100.0 МБ');
  });

  it('отсутствие win-unpacked отмечается в отчёте', () => {
    const report = buildReport({ ...base, unpackedBytes: undefined });
    expect(report).toContain('win-unpacked: не найден');
  });
});

describe('run (полный прогон на tmp-dist: отчёт-файл + код возврата)', () => {
  it('артефакты в пределах лимита → exit 0, отчёт записан', async () => {
    const distDir = await makeTmp('hl-size-run-ok-');
    await writeFile(join(distDir, 'Health Log Setup 0.0.0.exe'), Buffer.alloc(10, 1));
    await mkdir(join(distDir, 'win-unpacked'));
    await writeFile(join(distDir, 'win-unpacked', 'Health Log.exe'), Buffer.alloc(20, 1));

    const exitCode = await run({ distDir });

    expect(exitCode).toBe(0);
    const report = await readFile(join(distDir, REPORT_FILENAME), 'utf8');
    expect(report).toContain('установщик: 0.0 МБ');
    expect(report).toContain(': ок');
  });

  it('превышение лимита → exit 1, в отчёте ПРЕВЫШЕН', async () => {
    const distDir = await makeTmp('hl-size-run-over-');
    await writeFile(join(distDir, 'Health Log Setup 0.0.0.exe'), Buffer.alloc(MB + 1, 1));
    await mkdir(join(distDir, 'win-unpacked'));

    const exitCode = await run({ distDir, limitMb: 1 });

    expect(exitCode).toBe(1);
    const report = await readFile(join(distDir, REPORT_FILENAME), 'utf8');
    expect(report).toContain('ПРЕВЫШЕН');
  });

  it('артефактов нет → exit 1 с подсказкой собрать сначала', async () => {
    const distDir = await makeTmp('hl-size-run-none-');

    const exitCode = await run({ distDir });

    expect(exitCode).toBe(1);
    const report = await readFile(join(distDir, REPORT_FILENAME), 'utf8');
    expect(report).toContain('pnpm dist');
  });
});
