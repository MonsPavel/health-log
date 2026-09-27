/**
 * TASK-036 §19: юнит-тесты скрипта аудита размера установщика.
 *
 * Расчёты отделены от ФС: форматирование МБ, пороговые решения (ok/warn/exceeded),
 * группировка компонентов (§13) и топ-10 — чистые функции без реальной сборки.
 * Прогон run() и CLI (--json → JSON.parse, §20) — на tmp-фикстурах (mkdtemp —
 * прецедент check-size.test.mjs/vitest.setup.ts: ФС пользователя не затрагивается).
 * Сама сборка (`pnpm dist`) — не юнит-тест; реальный прогон §24 выполняется вручную.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  LIMIT_MB,
  MB,
  REPORT_FILENAME,
  TOP_N,
  WARN_MB,
  buildJson,
  buildReport,
  bytesToMb,
  classifyComponent,
  evaluateGate,
  findArtifacts,
  groupByComponent,
  run,
  topFiles,
  walkFiles,
} from './size-audit.mjs';

/** Скрипт для CLI-тестов (§20: --json разбирается JSON.parse без ошибок). */
const SCRIPT_PATH = fileURLToPath(new URL('./size-audit.mjs', import.meta.url));

/** Корень tmp-каталогов тестов; удаляется после прогона (§13: без следов). */
const tmpRoots = [];

/** Новый tmp-каталог с регистрацией на очистку. */
async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** Запуск CLI дочерним процессом node; возвращает код, stdout и stderr. */
function runCli(args) {
  return new Promise((resolveSpawn) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolveSpawn({ code, stdout, stderr }));
  });
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

describe('evaluateGate (§13 пороговые решения: лимит 200, warn 180 — чистая функция)', () => {
  it('100 МБ → ok', () => {
    expect(evaluateGate(100 * MB)).toBe('ok');
  });

  it('ровно 180 МБ → ok (warn — строго больше порога, §5 «>180 МБ»)', () => {
    expect(evaluateGate(WARN_MB * MB)).toBe('ok');
  });

  it('180 МБ + 1 байт → warn', () => {
    expect(evaluateGate(WARN_MB * MB + 1)).toBe('warn');
  });

  it('ровно 200 МБ → warn (зона предупреждения 180–200, §20)', () => {
    expect(evaluateGate(LIMIT_MB * MB)).toBe('warn');
  });

  it('200 МБ + 1 байт → exceeded (гейт, §13)', () => {
    expect(evaluateGate(LIMIT_MB * MB + 1)).toBe('exceeded');
  });

  it('переопределяемые пороги: 1.5 МБ при limit 2 / warn 1 → warn', () => {
    expect(evaluateGate(1.5 * MB, 2, 1)).toBe('warn');
  });
});

describe('classifyComponent (§13 группировка: locales, *.node, dist-renderer, dist-main, resources)', () => {
  it('locales/*.pak → locales (Electron)', () => {
    expect(classifyComponent('locales/en-US.pak')).toBe('locales (Electron)');
  });

  it('нативный модуль *.node в глубине app.asar.unpacked → native (*.node)', () => {
    expect(
      classifyComponent(
        'resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node',
      ),
    ).toBe('native (*.node)');
  });

  it('dist-main/index.js → dist-main', () => {
    expect(classifyComponent('dist-main/index.js')).toBe('dist-main (main bundle)');
  });

  it('dist-renderer/assets/*.js → dist-renderer', () => {
    expect(classifyComponent('dist-renderer/assets/index-a1b2c3.js')).toBe(
      'dist-renderer (renderer bundle)',
    );
  });

  it('resources/app.asar → resources', () => {
    expect(classifyComponent('resources/app.asar')).toBe('resources');
  });

  it('файл в корне win-unpacked → electron-runtime (крупнейший компонент, §24)', () => {
    expect(classifyComponent('Health Log.exe')).toBe('electron-runtime (root files)');
    expect(classifyComponent('ffmpeg.dll')).toBe('electron-runtime (root files)');
  });

  it('вложенный файл без известных сегментов → other', () => {
    expect(classifyComponent('swiftshader/lib/foo.dll')).toBe('other');
  });

  it('обратный слэш Windows тоже разделяет сегменты', () => {
    expect(classifyComponent('locales\\ru.pak')).toBe('locales (Electron)');
  });
});

describe('groupByComponent / topFiles (агрегаты по дереву файлов)', () => {
  const files = [
    { relPath: 'a.bin', bytes: 300 },
    { relPath: 'locales/x.pak', bytes: 200 },
    { relPath: 'resources/app.asar', bytes: 100 },
  ];

  it('группы просуммированы и отсортированы по убыванию', () => {
    const groups = groupByComponent(files, 600);
    expect(groups.map((g) => g.name)).toEqual([
      'electron-runtime (root files)',
      'locales (Electron)',
      'resources',
    ]);
    expect(groups[0].bytes).toBe(300);
  });

  it('sharePct — доля группы в процентах с одним знаком', () => {
    const groups = groupByComponent(files, 600);
    expect(groups[0].sharePct).toBe(50);
    expect(groups[1].sharePct).toBe(33.3);
  });

  it('topFiles: не более TOP_N, по убыванию размера', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      relPath: `f${String(i).padStart(2, '0')}.bin`,
      bytes: i + 1,
    }));
    const top = topFiles(many);
    expect(top).toHaveLength(TOP_N);
    expect(top[0].relPath).toBe('f11.bin');
    expect(top[9].relPath).toBe('f02.bin');
  });

  it('topFiles: равные размеры — детерминированный порядок по relPath', () => {
    const top = topFiles([
      { relPath: 'b.bin', bytes: 5 },
      { relPath: 'a.bin', bytes: 5 },
    ]);
    expect(top.map((f) => f.relPath)).toEqual(['a.bin', 'b.bin']);
  });
});

describe('findArtifacts (release-каталог и переданный напрямую win-unpacked)', () => {
  it('release-каталог: установщик «* Setup *.exe» + win-unpacked', async () => {
    const distDir = await makeTmp('hl-audit-rel-');
    const installerPath = join(distDir, 'Health Log Setup 0.0.0.exe');
    await writeFile(installerPath, Buffer.alloc(10, 1));
    const unpackedPath = join(distDir, 'win-unpacked');
    await mkdir(unpackedPath);
    await writeFile(join(distDir, 'builder-debug.yml'), 'x');

    const artifacts = await findArtifacts(distDir);
    expect(artifacts.installerPath).toBe(installerPath);
    expect(artifacts.unpackedPath).toBe(unpackedPath);
  });

  it('каталог без установщика, но с win-unpacked → распакованный найден', async () => {
    const distDir = await makeTmp('hl-audit-noinst-');
    await mkdir(join(distDir, 'win-unpacked'));

    const artifacts = await findArtifacts(distDir);
    expect(artifacts.installerPath).toBeUndefined();
    expect(artifacts.unpackedPath).toBe(join(distDir, 'win-unpacked'));
  });

  it('передан сам win-unpacked (Health Log.exe + resources) → каталог распознаётся', async () => {
    const unpackedDir = await makeTmp('hl-audit-unp-');
    await writeFile(join(unpackedDir, 'Health Log.exe'), Buffer.alloc(10, 1));
    await mkdir(join(unpackedDir, 'resources'));

    const artifacts = await findArtifacts(unpackedDir);
    expect(artifacts.unpackedPath).toBe(unpackedDir);
    expect(artifacts.installerPath).toBeUndefined();
  });

  it('пустой каталог → оба артефакта не найдены (run() вернёт exit 2)', async () => {
    const distDir = await makeTmp('hl-audit-empty-');
    const artifacts = await findArtifacts(distDir);
    expect(artifacts.installerPath).toBeUndefined();
    expect(artifacts.unpackedPath).toBeUndefined();
  });
});

describe('walkFiles (рекурсивный обход: путь + размер каждого файла)', () => {
  it('вложенное дерево: все файлы с корректными размерами', async () => {
    const dir = await makeTmp('hl-audit-walk-');
    await writeFile(join(dir, 'root.bin'), Buffer.alloc(100, 1));
    await mkdir(join(dir, 'locales'));
    await writeFile(join(dir, 'locales', 'en-US.pak'), Buffer.alloc(50, 1));
    await mkdir(join(dir, 'resources', 'app.asar.unpacked'), { recursive: true });
    await writeFile(
      join(dir, 'resources', 'app.asar.unpacked', 'native.node'),
      Buffer.alloc(25, 1),
    );

    const files = await walkFiles(dir);
    expect(files).toHaveLength(3);
    const byRel = new Map(files.map((f) => [f.relPath, f.bytes]));
    expect(byRel.get('root.bin')).toBe(100);
    expect(byRel.get(join('locales', 'en-US.pak'))).toBe(50);
    expect(byRel.get(join('resources', 'app.asar.unpacked', 'native.node'))).toBe(25);
  });
});

describe('buildReport / buildJson (текстовый и JSON-отчёт — чистые функции)', () => {
  const measurement = {
    distDir: 'D:\\out',
    limitMb: LIMIT_MB,
    warnMb: WARN_MB,
    installer: { path: 'D:\\out\\Health Log Setup 0.0.0.exe', bytes: 125_941_529, mb: 120.1 },
    unpacked: { path: 'D:\\out\\win-unpacked', bytes: 300 * MB, mb: 300 },
    gate: { subject: 'installer', bytes: 125_941_529, mb: 120.1, verdict: 'ok', exitCode: 0 },
    components: [
      { name: 'electron-runtime (root files)', bytes: 200 * MB, mb: 200, sharePct: 66.7 },
      { name: 'locales (Electron)', bytes: 100 * MB, mb: 100, sharePct: 33.3 },
    ],
    topFiles: [
      {
        relPath: 'Health Log.exe',
        bytes: 200 * MB,
        mb: 200,
        component: 'electron-runtime (root files)',
      },
    ],
    exitCode: 0,
  };

  it('ok: вердикт в пределах, лимит и путь установщика в отчёте (§20)', () => {
    const report = buildReport(measurement);
    expect(report).toContain('TASK-036');
    expect(report).toContain('size audit');
    expect(report).toContain('120.1 MB');
    expect(report).toContain(`within the ${LIMIT_MB} MB limit`);
    expect(report).toContain('Health Log Setup 0.0.0.exe');
  });

  it('warn: строка-предупреждение «близко к лимиту» (§20: 180–200)', () => {
    const report = buildReport({
      ...measurement,
      gate: { subject: 'installer', bytes: 185 * MB, mb: 185, verdict: 'warn', exitCode: 0 },
    });
    expect(report).toContain('WARNING');
    expect(report).toContain('close to');
  });

  it('exceeded: вердикт превышения с отсылкой к D1a-решению (§22)', () => {
    const report = buildReport({
      ...measurement,
      gate: { subject: 'installer', bytes: 210 * MB, mb: 210, verdict: 'exceeded', exitCode: 1 },
    });
    expect(report).toContain('EXCEEDED');
    expect(report).toContain('D1a');
  });

  it('таблица компонентов и топ-10 присутствуют (§5)', () => {
    const report = buildReport(measurement);
    expect(report).toContain('electron-runtime (root files)');
    expect(report).toContain('components');
    expect(report).toContain('top 10');
    expect(report).toContain('Health Log.exe');
  });

  it('отсутствие установщика помечено в отчёте (гейт переходит на win-unpacked)', () => {
    const report = buildReport({
      ...measurement,
      installer: undefined,
      gate: { subject: 'win-unpacked', bytes: 300 * MB, mb: 300, verdict: 'exceeded', exitCode: 1 },
    });
    expect(report).toContain('installer: not found');
    expect(report).toContain('win-unpacked 300 MB');
  });

  it('buildJson возвращает сериализуемый объект с гейтом и артефактами', () => {
    const json = buildJson(measurement);
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.limitMb).toBe(LIMIT_MB);
    expect(parsed.warnMb).toBe(WARN_MB);
    expect(parsed.gate.subject).toBe('installer');
    expect(parsed.gate.verdict).toBe('ok');
    expect(parsed.installer.mb).toBe(120.1);
    expect(parsed.unpacked.mb).toBe(300);
    expect(parsed.components).toHaveLength(2);
    expect(parsed.topFiles[0].relPath).toBe('Health Log.exe');
  });
});

describe('run (полный прогон на tmp-фикстурах: exit 0/1/2 + файл отчёта)', () => {
  /** Фикстура release-каталога: установщик + win-unpacked с одним файлом. */
  async function makeRelease({ installerBytes, unpackedFileBytes }) {
    const distDir = await makeTmp('hl-audit-run-');
    if (installerBytes !== undefined) {
      await writeFile(join(distDir, 'Health Log Setup 0.0.0.exe'), Buffer.alloc(installerBytes, 1));
    }
    const unpacked = join(distDir, 'win-unpacked');
    await mkdir(unpacked);
    if (unpackedFileBytes !== undefined) {
      await writeFile(join(unpacked, 'Health Log.exe'), Buffer.alloc(unpackedFileBytes, 1));
    }
    return distDir;
  }

  it('в пределах лимита → exit 0, отчёт записан в каталог dist (§24)', async () => {
    const distDir = await makeRelease({ installerBytes: 10, unpackedFileBytes: 20 });

    const result = await run({ distDir });

    expect(result.exitCode).toBe(0);
    expect(result.report).toContain('verdict: OK');
    const saved = await readFile(join(distDir, REPORT_FILENAME), 'utf8');
    expect(saved).toContain('verdict: OK');
  });

  it('warn-зона (1.5 МБ при limit 2 / warn 1) → exit 0 со строкой WARNING', async () => {
    const distDir = await makeRelease({
      installerBytes: Math.round(1.5 * MB),
      unpackedFileBytes: 1,
    });

    const result = await run({ distDir, limitMb: 2, warnMb: 1 });

    expect(result.exitCode).toBe(0);
    expect(result.report).toContain('WARNING');
  });

  it('превышение лимита → exit 1 (гейт, §13)', async () => {
    const distDir = await makeRelease({ installerBytes: MB + 1, unpackedFileBytes: 1 });

    const result = await run({ distDir, limitMb: 1, warnMb: 0.5 });

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain('EXCEEDED');
  });

  it('установщика нет, win-unpacked в пределах → гейт по win-unpacked, exit 0', async () => {
    const distDir = await makeRelease({ installerBytes: undefined, unpackedFileBytes: 20 });

    const result = await run({ distDir });

    expect(result.exitCode).toBe(0);
    expect(result.json.gate.subject).toBe('win-unpacked');
  });

  it('каталог не существует → exit 2 (ошибка вызова, §13)', async () => {
    const result = await run({ distDir: join(await makeTmp('hl-audit-miss-'), 'nope') });
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain('not found');
  });

  it('каталог без артефактов сборки → exit 2 (не release-каталог)', async () => {
    const distDir = await makeTmp('hl-audit-junk-');
    await writeFile(join(distDir, 'readme.txt'), 'x');

    const result = await run({ distDir });

    expect(result.exitCode).toBe(2);
    expect(result.error).toContain('release');
  });
});

describe('CLI (дочерний процесс node): флаги --dist/--json, коды выхода', () => {
  /** CLI-фикстура release-каталога в пределах лимита. */
  async function makeOkRelease() {
    const distDir = await makeTmp('hl-audit-cli-');
    await writeFile(join(distDir, 'Health Log Setup 0.0.0.exe'), Buffer.alloc(10, 1));
    await mkdir(join(distDir, 'win-unpacked'));
    await writeFile(join(distDir, 'win-unpacked', 'Health Log.exe'), Buffer.alloc(20, 1));
    await writeFile(join(distDir, 'win-unpacked', 'locales.pak'), Buffer.alloc(5, 1));
    await mkdir(join(distDir, 'win-unpacked', 'locales'));
    await writeFile(join(distDir, 'win-unpacked', 'locales', 'en-US.pak'), Buffer.alloc(8, 1));
    return distDir;
  }

  it('--json: stdout разбирается JSON.parse без ошибок (§20), обход ≤5 c (§15)', async () => {
    const distDir = await makeOkRelease();
    const started = Date.now();

    const { code, stdout } = await runCli(['--dist', distDir, '--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.gate.subject).toBe('installer');
    expect(parsed.installer.bytes).toBe(10);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  it('без --json: человекочитаемый отчёт в stdout', async () => {
    const distDir = await makeOkRelease();

    const { code, stdout } = await runCli(['--dist', distDir]);

    expect(code).toBe(0);
    expect(stdout).toContain('verdict: OK');
    expect(stdout).toContain('top 10');
  }, 15000);

  it('без --dist → usage и exit 2', async () => {
    const { code, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stderr).toContain('usage');
  }, 15000);

  it('несуществующий каталог → exit 2 (в --json-режиме stdout тоже парсится)', async () => {
    const { code, stdout } = await runCli(['--dist', 'Z:\\definitely-missing', '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(stdout).exitCode).toBe(2);
  }, 15000);
});
