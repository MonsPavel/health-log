/**
 * TASK-013 §17: check:i18n — сверка используемых i18n-ключей с каталогом ru
 * (источник истины). Grep-based подход (TD-IMP-2): из исходников src-renderer
 * извлекаются строковые литералы вида `common.*` / `errors.*` (литералы в t('…'),
 * пропсы titleKey="…", константы ключей), каталог i18n/ru/*.json разворачивается
 * в плоские dot-ключи.
 *
 * Ошибки: (1) используемый ключ отсутствует в каталоге; (2) ключ каталога common
 * никем не использован. Namespace errors исключён из unused-проверки НАМЕРЕННО:
 * его ключи приходят из IPC как messageKey (contracts, TASK-008) и потребляются
 * динамически (translateMessageKey, арх. 06 §6) — grep их потребление не видит.
 *
 * Конвенция (§22): динамические ключи в t() запрещены — только литералы; тестовые
 * файлы (*.test.ts/tsx) не считаются ни источником ключей, ни их потреблением.
 * При первом обоснованном исключении — замена на eslint-плагин (TD-IMP-2).
 *
 * CLI: node tools/scripts/check-i18n.mjs [--src <dir>] [--i18n <dir>]
 * По умолчанию — apps/desktop/src-renderer и его i18n/ от корня монорепо.
 * Exit 0 — чисто; exit 1 — есть расхождения. Подключается в CI с TASK-014 (§17).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Расширения исходников, в которых ищутся ключи. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Тесты исключены: фикстурные ключи в них — не потребление. */
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

/**
 * Кандидаты-ключи: строковые литералы с префиксом группы каталога. Явный префикс
 * отсекает ложные срабатывания на обычных строках (§22) и фиксирует конвенцию
 * «полное имя ключа в литерале».
 */
const KEY_LITERAL_PATTERN = /(['"])(common|errors)\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\1/g;

/** Namespace, чьи ключи приходят динамически и вне unused-проверки (арх. 06 §6). */
const DYNAMIC_CONSUMPTION_NAMESPACES = new Set(['errors']);

/** Рекурсивный обход каталога исходников: .ts/.tsx без тестов. */
function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(extname(entry.name)) &&
      !TEST_FILE_PATTERN.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Используемые ключи: Map<ключ, массив относительных файлов>. */
export function extractUsedKeys(srcDir) {
  const used = new Map();
  for (const file of listSourceFiles(srcDir)) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(KEY_LITERAL_PATTERN)) {
      const key = `${match[2]}.${match[3]}`;
      const files = used.get(key) ?? [];
      if (!files.includes(file)) {
        files.push(file);
      }
      used.set(key, files);
    }
  }
  return used;
}

/** Разворот каталога в плоские dot-ключи: common.json → common.nav.dashboard. */
export function flattenCatalogKeys(i18nDir) {
  const keys = new Set();
  for (const entry of readdirSync(i18nDir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== '.json') {
      continue;
    }
    const namespace = basename(entry.name, '.json');
    const flatten = (node, prefix) => {
      for (const [name, value] of Object.entries(node)) {
        const key = `${prefix}.${name}`;
        if (value !== null && typeof value === 'object') {
          flatten(value, key);
        } else {
          keys.add(key);
        }
      }
    };
    const content = JSON.parse(readFileSync(join(i18nDir, entry.name), 'utf8'));
    flatten(content, namespace);
  }
  return keys;
}

/** Namespace ключа: сегмент до первой точки. */
function namespaceOf(key) {
  return key.slice(0, key.indexOf('.'));
}

/**
 * Сверка: missing — использованные ключи вне каталога; unused — ключи common,
 * не найденные в исходниках (errors.* исключены — динамическое потребление).
 */
export function checkI18nKeys({ srcDir, i18nDir }) {
  const used = extractUsedKeys(srcDir);
  const catalog = flattenCatalogKeys(i18nDir);

  const missing = [];
  for (const [key, files] of used) {
    if (!catalog.has(key)) {
      missing.push({ key, files });
    }
  }
  const unused = [...catalog].filter(
    (key) => !used.has(key) && !DYNAMIC_CONSUMPTION_NAMESPACES.has(namespaceOf(key)),
  );

  return { missing, unused };
}

function parseArgs(argv) {
  const args = { src: undefined, i18n: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--src') {
      args.src = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--i18n') {
      args.i18n = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function main() {
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const args = parseArgs(process.argv.slice(2));
  const srcDir = resolve(args.src ?? join(repoRoot, 'apps', 'desktop', 'src-renderer'));
  const i18nDir = resolve(args.i18n ?? join(srcDir, 'i18n', 'ru'));

  const { missing, unused } = checkI18nKeys({ srcDir, i18nDir });

  for (const { key, files } of missing) {
    const where = files.map((file) => relative(process.cwd(), file)).join(', ');
    console.error(`check:i18n: ключ "${key}" используется, но отсутствует в каталоге: ${where}`);
  }
  for (const key of unused) {
    console.error(`check:i18n: ключ "${key}" есть в каталоге, но не используется (unused)`);
  }

  if (missing.length > 0 || unused.length > 0) {
    process.exitCode = 1;
    return;
  }
  const total = flattenCatalogKeys(i18nDir).size;
  console.log(`check:i18n: OK — каталог согласован (${total} ключей)`);
}

/** Запуск как CLI: сравнение путей через realpath — Windows-регистр и symlink. */
const thisFile = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(thisFile);
if (invokedDirectly) {
  main();
}
