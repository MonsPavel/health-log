/**
 * TASK-114 §19/§24: сверка release notes с шаблоном `.github/release-template.md`
 * — воспроизводимая замена «глазной сверки» приёмки (§24 спеки, шаг «Релиз»
 * CONTRIBUTING §11).
 *
 * Зачем: живой rc.0 (run 37132708817) собрал draft по фолбэк-заглушке — шаблона
 * не было в коммите тега, сверить §19 «draft содержит все {{}}-плейсхолдеры»
 * было не с чем. Скрипт проверяет оба условия ДО сверки тела:
 *   1. шаблон существует в коммите тега (gh api contents?ref=<тег>) — иначе
 *      «перевыставь тег» (сам отказ rc.0);
 *   2. draft release для тега существует (gh api releases; черновики видны
 *      только аутентифицированному gh со scope repo).
 *
 * Режимы сверки тела draft:
 *   - по умолчанию (§19, сразу после rc-прогона): все секции шаблона и ВСЕ
 *     {{}}-плейсхолдеры присутствуют в теле (заготовка не потерялась);
 *   - `--filled` (§24, перед «Publish release»): секции на месте, ни одного
 *     незаполненного плейсхолдера (§4 спеки: пустые {{}} видны — гейт их ловит),
 *     дисклеймер не удалён.
 *
 * Сеть — только gh CLI (аутентификация — `gh auth status`); тесты идут на
 * инъекции (§14 тестов net-audit: без сети). Usage-ошибки — exit 2 до любых
 * вызовов; несоответствие — exit 1 с перечнем проблем; успех — exit 0.
 * Запуск: `node tools/scripts/verify-release-notes.mjs v0.9.0-rc.1 [--filled]`.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Корень монорепо от этого файла (tools/scripts → на 2 уровня вверх). */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Шаблон notes — источник ожидаемых секций/плейсхолдеров (§5 спеки). */
export const TEMPLATE_PATH = '.github/release-template.md';

/** Репозиторий для gh api (gh вызывается из checkout — slug фиксирован). */
export const REPO_SLUG = 'MonsPavel/health-log';

/** §5: дисклеймер обязателен в каждой версии notes. */
export const DISCLAIMER_MARKER = 'не является медицинской консультацией';

const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/g;

/** Заголовки `## …` шаблона по порядку. */
export function extractSections(templateText) {
  return [...templateText.matchAll(/^## .+$/gm)].map((m) => m[0]);
}

/** Плейсхолдеры `{{…}}` текста (уникальные, в порядке появления). */
export function extractPlaceholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0]))];
}

/** Текст шаблона из рабочей копии (CRLF Windows нормализуем). */
export function loadTemplate() {
  return readFileSync(join(REPO_ROOT, TEMPLATE_PATH), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Сверка тела draft с шаблоном (чистая функция — без сети).
 *
 *  - обе стороны: каждая секция шаблона присутствует в теле; дисклеймер на месте;
 *  - заготовка (filled=false, §19): каждый плейсхолдер шаблона есть в теле;
 *  - заполненные notes (filled=true, §24): в теле не осталось ни одного {{…}}.
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyDraftBody(templateText, body, { filled = false } = {}) {
  const problems = [];
  for (const heading of extractSections(templateText)) {
    if (!body.includes(heading)) {
      problems.push(`секция шаблона отсутствует в теле: ${heading}`);
    }
  }
  if (filled) {
    for (const placeholder of extractPlaceholders(body)) {
      problems.push(`незаполненный плейсхолдер в notes: ${placeholder}`);
    }
  } else {
    for (const placeholder of extractPlaceholders(templateText)) {
      if (!body.includes(placeholder)) {
        problems.push(`плейсхолдер шаблона отсутствует в теле draft: ${placeholder}`);
      }
    }
  }
  if (!body.includes(DISCLAIMER_MARKER)) {
    problems.push('дисклеймер отсутствует в теле');
  }
  return { ok: problems.length === 0, problems };
}

/** gh-раннер по умолчанию: {code, stdout, stderr} (аутентификация — снаружи). */
function defaultGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err === null || err === undefined ? 0 : (err.code ?? 1),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : String(err?.message ?? ''),
      });
    });
  });
}

/**
 * Прогон сверки. Инъекции (gh, templateText, log/error) — только для тестов.
 * @returns {Promise<{exitCode: number}>}
 */
export async function run(options = {}) {
  const {
    argv = [],
    gh = defaultGh,
    templateText,
    log = console.log,
    error = console.error,
  } = options;

  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const filled = argv.includes('--filled');
  if (positional.length !== 1) {
    error('usage: node tools/scripts/verify-release-notes.mjs <тег, напр. v0.9.0-rc.1> [--filled]');
    return { exitCode: 2 };
  }
  const tag = positional[0];

  // Шаг 1: шаблон в коммите тега (урок rc.0: без этого сверять нечего).
  const templateInTag = await gh([
    'api',
    `repos/${REPO_SLUG}/contents/${TEMPLATE_PATH}?ref=${tag}`,
  ]);
  if (templateInTag.code !== 0) {
    error(
      `FAIL: шаблон ${TEMPLATE_PATH} не найден в коммите тега ${tag} — draft мог быть собран по заглушке (§20-2); добавь шаблон в тег и перевыставь его`,
    );
    return { exitCode: 1 };
  }
  const template = templateText ?? loadTemplate();

  // Шаг 2: draft для тега (черновики видны только аутентифицированному gh).
  const releasesResponse = await gh(['api', `repos/${REPO_SLUG}/releases`]);
  if (releasesResponse.code !== 0) {
    error(`FAIL: gh api releases завершился с ошибкой: ${releasesResponse.stderr.trim()}`);
    return { exitCode: 1 };
  }
  let releases;
  try {
    releases = JSON.parse(releasesResponse.stdout);
  } catch {
    error('FAIL: gh api releases вернул не-JSON');
    return { exitCode: 1 };
  }
  const draft = (Array.isArray(releases) ? releases : []).find(
    (release) => release?.draft === true && release?.tag_name === tag,
  );
  if (draft === undefined) {
    error(
      `FAIL: draft release для тега ${tag} не найден — прогон не дошёл до draft (красный гейт) или черновик удалён`,
    );
    return { exitCode: 1 };
  }

  // Шаг 3: сверка тела с шаблоном.
  const verdict = verifyDraftBody(template, draft.body ?? '', { filled });
  if (!verdict.ok) {
    error(
      `FAIL: тело draft ${tag} не соответствует шаблону (${filled ? 'режим заполненных notes §24' : 'режим заготовки §19'}):`,
    );
    for (const problem of verdict.problems) {
      error(`  - ${problem}`);
    }
    return { exitCode: 1 };
  }

  const placeholders = extractPlaceholders(template);
  log(
    `OK: draft ${tag} соответствует шаблону: секций ${extractSections(template).length}, ` +
      (filled
        ? `плейсхолдеров не осталось (все ${placeholders.length} заполнены), дисклеймер на месте — можно публиковать (§24).`
        : `плейсхолдеров ${placeholders.length} (заготовка §19) — заполняй по служебному чек-листу шаблона, затем перепроверь с --filled.`),
  );
  return { exitCode: 0 };
}

/** Точка входа: только при прямом запуске (импорт тестами — без сети). */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await run({ argv: process.argv.slice(2) });
  process.exitCode = result.exitCode;
}
