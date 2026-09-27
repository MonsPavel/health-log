/**
 * TASK-035 §19/§24 (ревью приёмки): юнит-тест сборщика диагностики падения e2e.
 * Флейк-политика §19 — «падение = расследование»: при падении прогона tmp-userData
 * (факты изоляции: наличие/размер БД и ключа) и main-лог приложения (код ошибки
 * repo.add/IPC виден только там) копируются в test-results ДО того, как следующий
 * прогон перезапишет ротационный лог. Сборщик обязан никогда не бросать: диагностика
 * не должна маскировать исходную ошибку теста.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectDiagnostics } from './collect-diagnostics.js';

/** Каталоги прогона и приёмки; чистятся после каждого теста (прецедент fixture §14). */
const scratch: string[] = [];

async function makeScratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('collectDiagnostics (TASK-035)', () => {
  it('копирует ротационные hl*.log и файлы tmp-userData, пишет манифест', async () => {
    const logsDir = await makeScratchDir('hl-t-logs-');
    const userDataDir = await makeScratchDir('hl-t-user-');
    const destDir = await makeScratchDir('hl-t-dest-');
    await writeFile(join(logsDir, 'hl.1.log'), '{"level":"error","msg":"measurement.add failed"}');
    await writeFile(join(logsDir, 'hl.2.log'), '{"level":"info","msg":"older"}');
    await writeFile(join(logsDir, 'unrelated.log'), 'не лог приложения');
    await writeFile(join(userDataDir, 'health-log.db'), 'db-bytes');
    await writeFile(join(userDataDir, 'vault.key'), 'key-bytes');

    await collectDiagnostics({ userDataDir, logsDir, destDir });

    const copiedLog = await readFile(join(destDir, 'logs', 'hl.1.log'), 'utf8');
    expect(copiedLog).toContain('measurement.add failed');
    expect(existsSync(join(destDir, 'logs', 'hl.2.log'))).toBe(true);
    expect(existsSync(join(destDir, 'logs', 'unrelated.log'))).toBe(false);
    expect(existsSync(join(destDir, 'userdata', 'health-log.db'))).toBe(true);
    expect(existsSync(join(destDir, 'userdata', 'vault.key'))).toBe(true);

    const manifest = JSON.parse(await readFile(join(destDir, 'diagnostics.json'), 'utf8')) as {
      logs: string[];
      userData: string[];
    };
    expect(manifest.logs).toContain('hl.1.log');
    expect(manifest.userData).toContain('health-log.db');
  });

  it('манифест не содержит абсолютных путей (каталог tmp содержит имя пользователя, §14)', async () => {
    const logsDir = await makeScratchDir('hl-t-logs-');
    const userDataDir = await makeScratchDir('hl-t-user-');
    const destDir = await makeScratchDir('hl-t-dest-');
    await writeFile(join(logsDir, 'hl.1.log'), '{}');
    await writeFile(join(userDataDir, 'health-log.db'), 'x');

    await collectDiagnostics({ userDataDir, logsDir, destDir });

    const raw = await readFile(join(destDir, 'diagnostics.json'), 'utf8');
    expect(raw).not.toContain(userDataDir);
    expect(raw).not.toContain(logsDir);
    expect(raw).not.toContain(destDir);
  });

  it('отсутствующие каталоги-источники и вложенные папки не роняют сбор (never throws)', async () => {
    const destDir = await makeScratchDir('hl-t-dest-');
    const userDataDir = await makeScratchDir('hl-t-user-');
    // Вложенный каталог (не файл) — должен быть пропущен с записью в манифест.
    await mkdir(join(userDataDir, 'Nested'));
    await collectDiagnostics({
      userDataDir,
      logsDir: join(destDir, 'нет-такого-каталога'),
      destDir,
    });

    const manifest = JSON.parse(await readFile(join(destDir, 'diagnostics.json'), 'utf8')) as {
      logs: string[];
      userData: string[];
      errors: string[];
    };
    expect(manifest.logs).toEqual([]);
    expect(manifest.userData).toEqual([]);
    expect(manifest.errors.length).toBeGreaterThan(0);
    // Файлов userdata не появилось — каталог Nested не скопирован как файл.
    expect(readdir(join(destDir, 'userdata'))).resolves.toEqual([]);
  });
});
