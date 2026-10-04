/**
 * TASK-114 §19/§24: тесты скрипта сверки release notes с шаблоном
 * (`tools/scripts/verify-release-notes.mjs`) — прецедент net-audit.test.mjs:
 * чистые функции без сети (инъекция runner'а gh), CLI-usage — exit 2 спавном
 * node, живой rc-прогон (§24) — запуск вручную при приёмке.
 *
 * Урок rc.0 (run 37132708817): draft собрался по фолбэк-заглушке — объект
 * сверки отсутствовал. Скрипт ловит оба отказа: (а) шаблона нет в коммите
 * тега (сверить нечего — перевыставить тег), (б) draft не найден/удалён.
 *
 * Слои:
 *  1. verifyDraftBody: секции шаблона в теле; режим заготовки (§19) — все
 *     {{}}-плейсхолдеры шаблона присутствуют; режим --filled (§24 перед
 *     публикацией) — не осталось ни одного; дисклеймер на месте в обоих;
 *  2. run() с инъекцией gh: 404 шаблона в теге → exit 1; нет draft → exit 1;
 *     успех → exit 0 и вызовы gh по нужным endpoint'ам;
 *  3. CLI: без аргументов → exit 2 + usage, без обращения к gh.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  extractPlaceholders,
  extractSections,
  loadTemplate,
  run,
  verifyDraftBody,
} from './verify-release-notes.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./verify-release-notes.mjs', import.meta.url));

/** Минимальный шаблон-фикстура: 2 секции, 2 плейсхолдера, дисклеймер. */
const TEMPLATE_FIXTURE = [
  '> Приложение не является медицинской консультацией.',
  '',
  '## Что нового',
  '',
  '## Версии внутри',
  '',
  '- Приложение: {{app}}',
  '- Perf: {{perf}}',
].join('\n');

/** Changelog-хвост, который generate_release_notes дописывает ПОД шаблон. */
const CHANGELOG_SUFFIX = "\n\n## What's Changed\n* feat: something by @someone\n";

/** Тело draft'а rc.0 по старой заглушке release.yml (объект отсутствующей сверки). */
const STUB_BODY_RC0 =
  '# Release v0.9.0-rc.0\n\n' +
  'Черновик релиза: заготовка notes — по шаблону .github/release-template.md (TASK-114); ' +
  'changelog-коммиты добавит GitHub ниже (generate_release_notes).\n';

/** CLI-запуск {code, stdout, stderr} (прецедент net-audit.test.mjs). */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** gh-двой: маршрутизация по endpoint'у + журнал вызовов. */
function ghDouble({ templateCode = 0, releasesJson = '[]' } = {}) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    const target = args.find((arg) => arg.startsWith('repos/'));
    if (target !== undefined && target.includes('/contents/')) {
      return templateCode === 0
        ? { code: 0, stdout: 'base64…', stderr: '' }
        : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    }
    if (target !== undefined && target.endsWith('/releases')) {
      return { code: 0, stdout: releasesJson, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected gh call' };
  };
  return { impl, calls };
}

afterAll(() => {});

describe('verifyDraftBody — сверка тела draft с шаблоном (§19/§24)', () => {
  it('режим заготовки: тело = шаблон + автоген changelog → ok', () => {
    const verdict = verifyDraftBody(TEMPLATE_FIXTURE, TEMPLATE_FIXTURE + CHANGELOG_SUFFIX);
    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  it('режим заготовки: тело-заглушка rc.0 → не ok, перечислены секции и плейсхолдеры', () => {
    const verdict = verifyDraftBody(loadTemplate(), STUB_BODY_RC0);
    expect(verdict.ok).toBe(false);
    for (const marker of ['## Что нового', '## Обновление', '{{app}}', '{{dod}}']) {
      expect(
        verdict.problems.some((problem) => problem.includes(marker)),
        `нет проблемы про ${marker}: ${JSON.stringify(verdict.problems)}`,
      ).toBe(true);
    }
  });

  it('режим --filled: все плейсхолдеры заполнены → ok', () => {
    const body = TEMPLATE_FIXTURE.replaceAll('{{app}}', '0.9.0-rc.1').replaceAll(
      '{{perf}}',
      'docs/release/perf-mvp.md',
    );
    const verdict = verifyDraftBody(TEMPLATE_FIXTURE, body, { filled: true });
    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  it('режим --filled: забытый {{perf}} → не ok с указанием плейсхолдера (§4: пропустить сложно)', () => {
    const body = TEMPLATE_FIXTURE.replaceAll('{{app}}', '0.9.0-rc.1');
    const verdict = verifyDraftBody(TEMPLATE_FIXTURE, body, { filled: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((problem) => problem.includes('{{perf}}'))).toBe(true);
  });

  it('секция удалена при заполнении → не ok', () => {
    const body = TEMPLATE_FIXTURE.replace('## Версии внутри', '## Чем внутри')
      .replaceAll('{{app}}', '1')
      .replaceAll('{{perf}}', 'x');
    const verdict = verifyDraftBody(TEMPLATE_FIXTURE, body, { filled: true });
    expect(verdict.problems.some((problem) => problem.includes('## Версии внутри'))).toBe(true);
  });

  it('дисклеймер удалён → не ok в обоих режимах (§5: дисклеймер — каждая версия)', () => {
    const stripped = TEMPLATE_FIXTURE.replace(
      '> Приложение не является медицинской консультацией.',
      '',
    );
    expect(verifyDraftBody(TEMPLATE_FIXTURE, stripped).ok).toBe(false);
    expect(
      verifyDraftBody(
        TEMPLATE_FIXTURE,
        stripped.replaceAll('{{app}}', '1').replaceAll('{{perf}}', 'x'),
        {
          filled: true,
        },
      ).ok,
    ).toBe(false);
  });
});

describe('extract* — секции и плейсхолдеры из текста', () => {
  it('секции — заголовки ## по порядку; плейсхолдеры — уникальные {{}}', () => {
    expect(extractSections(TEMPLATE_FIXTURE)).toEqual(['## Что нового', '## Версии внутри']);
    expect(extractPlaceholders(TEMPLATE_FIXTURE)).toEqual(['{{app}}', '{{perf}}']);
    expect(extractPlaceholders(TEMPLATE_FIXTURE + TEMPLATE_FIXTURE)).toEqual([
      '{{app}}',
      '{{perf}}',
    ]);
  });

  it('loadTemplate читает настоящий шаблон репозитория', () => {
    const template = loadTemplate();
    expect(template).toContain('## Версии внутри');
    expect(extractPlaceholders(template)).toContain('{{model|«ИИ не входит»}}');
  });
});

describe('run() — инъекция gh, без сети (§14 тестов)', () => {
  it('happy path: шаблон в теге + draft по шаблону → exit 0', async () => {
    const gh = ghDouble({
      releasesJson: JSON.stringify([
        { draft: false, tag_name: 'v1.0.0', body: 'published' },
        { draft: true, tag_name: 'v0.9.0-rc.1', body: TEMPLATE_FIXTURE + CHANGELOG_SUFFIX },
      ]),
    });
    const lines = [];
    const result = await run({
      argv: ['v0.9.0-rc.1'],
      gh: gh.impl,
      templateText: TEMPLATE_FIXTURE,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(lines.join('\n')).toContain('OK');
    // Оба endpoint'а: шаблон именно в коммите тега (урок rc.0) и список релизов.
    expect(
      gh.calls.some((args) =>
        args.some((arg) => arg.includes('/contents/') && arg.includes('ref=v0.9.0-rc.1')),
      ),
    ).toBe(true);
    expect(gh.calls.some((args) => args.some((arg) => arg.endsWith('/releases')))).toBe(true);
  });

  it('шаблона нет в коммите тега (404, как в rc.0) → exit 1 с причиной «перевыставь тег»', async () => {
    const gh = ghDouble({ templateCode: 1 });
    const lines = [];
    const result = await run({
      argv: ['v0.9.0-rc.0'],
      gh: gh.impl,
      templateText: TEMPLATE_FIXTURE,
      error: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('не найден в коммите тега');
    expect(lines.join('\n')).toContain('перевыставь');
  });

  it('draft для тега не найден (удалён/не дошёл прогон) → exit 1', async () => {
    const gh = ghDouble({
      releasesJson: JSON.stringify([{ draft: false, tag_name: 'v0.9.0-rc.1', body: 'x' }]),
    });
    const lines = [];
    const result = await run({
      argv: ['v0.9.0-rc.1'],
      gh: gh.impl,
      templateText: TEMPLATE_FIXTURE,
      error: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('draft release для тега v0.9.0-rc.1 не найден');
  });

  it('draft по заглушке → exit 1 с перечнем проблем (отказ rc.0 ловится)', async () => {
    const gh = ghDouble({
      releasesJson: JSON.stringify([{ draft: true, tag_name: 'v0.9.0-rc.0', body: STUB_BODY_RC0 }]),
    });
    const lines = [];
    const result = await run({
      argv: ['v0.9.0-rc.0'],
      gh: gh.impl,
      templateText: TEMPLATE_FIXTURE,
      error: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('не соответствует шаблону');
  });

  it('без тега → exit 2 (usage), gh не вызывался', async () => {
    const gh = ghDouble();
    const lines = [];
    const result = await run({
      argv: [],
      gh: async () => {
        throw new Error('gh не должен вызываться при usage-ошибке');
      },
      templateText: TEMPLATE_FIXTURE,
      error: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(2);
    expect(lines.join('\n')).toContain('usage:');
  });
});

describe('CLI (spawn node: usage — exit 2 до сети, §20)', () => {
  it('без аргументов → exit 2 + usage в stderr', async () => {
    const { code, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stderr).toContain('usage:');
  });
});
