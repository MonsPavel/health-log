/**
 * TASK-013 §17/§19: тест скрипта check:i18n (tools/scripts/check-i18n.mjs) —
 * фикстура-проект во временном каталоге (fs.mkdtemp — §13 vitest.setup):
 * чистый проект → exit 0; недостающий ключ → exit 1 с именем ключа и файла;
 * неиспользуемый ключ common → exit 1; errors.* вне unused-проверки (динамическое
 * потребление messageKey из IPC — арх. 06 §6); тестовые файлы не считаются
 * потреблением ключей. Скрипт запускается дочерним процессом node — end-to-end.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
// jsdom-проект vitest подменяет import.meta.url на не-file-схему — путь от cwd
// (корень монорепо, где запускается vitest).
const SCRIPT_PATH = resolve(process.cwd(), 'tools', 'scripts', 'check-i18n.mjs');

interface RunResult {
  readonly code: number;
  readonly stdout: string;
}

/** Запуск скрипта: exit code и вывод (stdout + stderr — находки пишутся в stderr). */
async function runScript(srcDir: string, i18nDir: string): Promise<RunResult> {
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT_PATH,
      '--src',
      srcDir,
      '--i18n',
      i18nDir,
    ]);
    return { code: 0, stdout };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const TMP_ROOT = join(tmpdir(), 'check-i18n-task-013-');
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Фикстура-проект: src/ с заданными файлами, i18n/ru/ с каталогами. */
async function makeFixture(files: Record<string, string>, common: object, errors: object) {
  const root = await mkdtemp(TMP_ROOT);
  tempDirs.push(root);
  const srcDir = join(root, 'src');
  const i18nDir = join(root, 'i18n', 'ru');
  await mkdir(srcDir, { recursive: true });
  await mkdir(i18nDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(srcDir, name);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  await writeFile(join(i18nDir, 'common.json'), JSON.stringify(common), 'utf8');
  await writeFile(join(i18nDir, 'errors.json'), JSON.stringify(errors), 'utf8');
  return { srcDir, i18nDir };
}

describe('check-i18n — сверка ключей с каталогом (§17)', () => {
  it('чистый проект: все ключи на месте, common использован — exit 0', async () => {
    const { srcDir, i18nDir } = await makeFixture(
      {
        'ui/screen.tsx': `export const s = () => p.t('common.wip');\n`,
      },
      { wip: 'Экран появится после настройки' },
      { internal: 'Что-то пошло не так. Попробуйте ещё раз.' },
    );

    const { code, stdout } = await runScript(srcDir, i18nDir);

    // errors.internal не использован — namespace errors вне unused-проверки (арх. 06 §6).
    expect(code).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('недостающий ключ: t() использует absent-ключ — exit 1, ключ и файл в выводе', async () => {
    const { srcDir, i18nDir } = await makeFixture(
      {
        'ui/screen.tsx': `const label = t('common.nope');\n`,
      },
      { wip: 'Экран появится после настройки' },
      { internal: '…' },
    );

    const { code, stdout } = await runScript(srcDir, i18nDir);

    expect(code).toBe(1);
    expect(stdout).toContain('common.nope');
    expect(stdout).toContain('screen.tsx');
  });

  it('неиспользуемый ключ common — exit 1 (мертвый текст каталога)', async () => {
    const { srcDir, i18nDir } = await makeFixture(
      {
        'ui/screen.tsx': `const label = t('common.used');\n`,
      },
      { used: 'Используется', unused: 'Никто не ссылается' },
      { internal: '…' },
    );

    const { code, stdout } = await runScript(srcDir, i18nDir);

    expect(code).toBe(1);
    expect(stdout).toContain('common.unused');
  });

  it('литерал в JSX-пропе titleKey="…" — использование ключа', async () => {
    const { srcDir, i18nDir } = await makeFixture(
      {
        'ui/screen.tsx': `const el = <Screen titleKey="common.title" />;\n`,
      },
      { title: 'Заголовок' },
      { internal: '…' },
    );

    const { code } = await runScript(srcDir, i18nDir);

    expect(code).toBe(0);
  });

  it('тестовые файлы не считаются потреблением: ключ только в *.test.ts — exit 1', async () => {
    const { srcDir, i18nDir } = await makeFixture(
      {
        'ui/screen.test.ts': `expect(t('common.wip')).toBe('…');\n`,
      },
      { wip: 'Экран появится после настройки' },
      { internal: '…' },
    );

    const { code, stdout } = await runScript(srcDir, i18nDir);

    expect(code).toBe(1);
    expect(stdout).toContain('common.wip');
  });

  it('вложенные каталоги src обходятся рекурсивно', async () => {
    const { srcDir, i18nDir } = await makeFixture(
      {
        'features/deep/nested/screen.tsx': `const label = t('common.deep');\n`,
      },
      { deep: 'Глубоко' },
      { internal: '…' },
    );

    const { code } = await runScript(srcDir, i18nDir);

    expect(code).toBe(0);
  });
});
