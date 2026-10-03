/**
 * TASK-110 §5: copy-audit — полу-автоматическая ревизия RU-текстов: скан всех
 * RU-каталогов рендерера (`src-renderer/**\/ru.json`) + RU-констант main
 * (critical-texts, refusal-texts, system-prompt + константы 087/068 из §13) на:
 *
 *  (1) запрет-корни SRS 01 §8 (спека §4: `диагноз|лечен|назнач|показани|
 *      гипертония у вас|вы больны|страдаете` + зеркальный порядок «у вас
 *      гипертония») — whitelist-подход: скан находит, ревьюер решил; каждая
 *      whitelist-строка — с комментарием-причиной (§22);
 *  (2) обязательные подстроки — таблица «ключ → обязательная подстрока» (§13):
 *      дисклеймер-ключи непусты и содержат формулировку FR-5.6 «не является
 *      медицинской консультацией» (SRS 01 §8), emergency-реестры — «103»;
 *      отсутствующий файл/ключ — находка (тихий пропуск = ложный PASS,
 *      прецедент contrast-audit);
 *  (3) params-дрейф — простая проверка фигурных скобок в обе стороны: параметр
 *      {{p}} из значения не передаётся ни одним t() (missing-in-usage) / t()
 *      передаёт параметр, которого в значении нет (missing-in-value). Ловит
 *      «{{median}} потерян при правке» (§13). Динамическое потребление
 *      (errors.* — messageKey из IPC, арх. 06 §6; privacy.ops.* — descriptionKey
 *      генерирует main, 098) вне проверки — тот же мотив, что у check-i18n.
 *
 * Запуск: `node tools/scripts/copy-audit.mjs [--root <dir>] [--json]`
 * (по умолчанию — корень монорепо). Коды возврата: 0 — вердикт OK; 1 — есть
 * находки (гейт §20); 2 — ошибка вызова/чтения. Зависимостей нет (node:fs).
 * Расчёты — чистые функции (§19 юнит-тесты: copy-audit.test.mjs).
 *
 * Тон-ревизия скриптом НЕ ловится («тон не грепается», §4) — ручной обход
 * экранов фиксируется в docs/release/ru-copy-review.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень монорепо (скрипт лежит в tools/scripts). */
export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Каталоги по умолчанию относительно корня монорепо. */
export const DEFAULT_SRC_DIR = 'apps/desktop/src-renderer';
export const DEFAULT_MAIN_DIR = 'apps/desktop/src';

/**
 * Запрет-корни (§4; SRS 01 §8: «диагноз», «у вас гипертония», «лечение»,
 * «показание», «назначение» — плюс рискованные обороты вины/состояния).
 * «гипертонический криз» НЕ корень (verbatim FR-7.4), «диагностика» (секция
 * настроек TASK-103) НЕ матчится корнем «диагноз» — разные основы.
 */
export const FORBIDDEN_ROOTS = [
  { id: 'диагноз', pattern: /диагноз/ },
  { id: 'лечен', pattern: /лечен/ },
  { id: 'назнач', pattern: /назнач/ },
  { id: 'показани', pattern: /показани/ },
  { id: 'гипертония у вас', pattern: /гипертони[а-я]\s+у\s+вас/ },
  { id: 'у вас гипертония', pattern: /у\s+вас\s+гипертони/ },
  { id: 'вы больны', pattern: /вы\s+больны/ },
  { id: 'страдаете', pattern: /страдаете/ },
];

/** Обязательная формулировка дисклеймера FR-5.6 (SRS 01 §8) — канон. */
export const DISCLAIMER_PHRASE = 'не является медицинской консультацией';

/**
 * Таблица обязательных подстрок (§13: ключ→обязательная подстрока). Пути —
 * от корня монорепо. kind: 'json' — ключ каталога (dot-путь); 'ts-regex' —
 * группа регэкспа по содержимому файла; 'ts-file' — конкатенация строковых
 * литералов файла. mustContain — подстрока; mustEqual — точное равенство.
 */
export const MANDATORY_STRINGS = [
  {
    id: 'fr56-disclaimer-renderer',
    kind: 'json',
    file: 'apps/desktop/src-renderer/features/ai/ru.json',
    key: 'ai.insight.disclaimer',
    mustContain: DISCLAIMER_PHRASE,
    why: 'FR-5.6: несъёмный дисклеймер экрана «Разбор» (081)',
  },
  {
    id: 'fr56-disclaimer-main-087',
    kind: 'ts-regex',
    file: 'apps/desktop/src/main/modules/ai-insight/application/generate-summary.ts',
    regex: /AI_SUMMARY_DISCLAIMER_TEXT(?:\s*:\s*string)?\s*=\s*'([^']+)'/,
    group: 1,
    mustContain: DISCLAIMER_PHRASE,
    why: 'FR-5.6: константа 087, сохраняется в ai_summary.disclaimer_text',
  },
  {
    id: 'fr56-disclaimer-report-aimark',
    kind: 'ts-regex',
    file: 'apps/desktop/src/main/modules/reporting/adapters/pdf/report-strings.ts',
    regex: /disclaimer:\s*'([^']+)'/,
    group: 1,
    mustContain: DISCLAIMER_PHRASE,
    why: 'FR-5.6: ИИ-маркировка в PDF-отчёте (report.aiMark, 068)',
  },
  {
    id: 'report-ai-tooltip',
    kind: 'json',
    file: 'apps/desktop/src-renderer/i18n/ru/report.json',
    key: 'report.includeAi.tooltip',
    mustContain: DISCLAIMER_PHRASE,
    why: 'FR-5.6: подсказка чекбокса ИИ-разбора (068 §58, единая формулировка)',
  },
  {
    id: 'system-prompt-disclaimer',
    kind: 'ts-file',
    file: 'apps/desktop/src/main/modules/ai-insight/application/prompts/system-prompt.ts',
    mustContain: DISCLAIMER_PHRASE,
    why: 'FR-5.6: пометка в ОБЯЗАТЕЛЬНО system prompt (084)',
  },
  {
    id: 'emergency-main-ru',
    kind: 'ts-regex',
    file: 'apps/desktop/src/main/shared/critical-texts.ts',
    regex: /ru:\s*\{\s*locale:\s*'ru',\s*primary:\s*'([^']+)'/,
    group: 1,
    mustEqual: '103',
    why: 'спека §5(2): emergency — «103» (реестр main, 041/086)',
  },
  {
    id: 'emergency-renderer-ru',
    kind: 'ts-regex',
    file: 'apps/desktop/src-renderer/components/critical-panel/emergency-numbers.ts',
    regex: /ru:\s*\{\s*locale:\s*'ru',\s*primary:\s*'([^']+)'/,
    group: 1,
    mustEqual: '103',
    why: 'спека §5(2): emergency — «103» (реестр панели 041, тест-сверка с main)',
  },
];

/**
 * Whitelist-обходы сканера (§22: каждая строка — с комментарием-причиной).
 * file — от корня монорепо; fragment — подстрока значения; root — какой корень
 * глушится. Правило проекта: whitelist не замусоривается — новая запись только
 * с причиной.
 */
export const WHITELIST = [
  {
    file: 'apps/desktop/src/main/modules/ai-insight/application/prompts/system-prompt.ts',
    fragment: 'Не ставь диагнозы',
    root: 'диагноз',
    reason:
      'system prompt 084, эшелон 1 (арх. 07 §4): слово «диагноз» использовано в инструкции-ЗАПРЕТЕ LLM, не в вердикте пользователю; SRS 01 §8 запрещает вердикты, а не запрет вердиктов',
  },
  {
    file: 'apps/desktop/src/main/modules/ai-insight/application/prompts/system-prompt.ts',
    fragment: 'любое лечение',
    root: 'лечен',
    reason:
      'system prompt 084: «лечение» в инструкции-запрете советовать лечение — LLM-контекст, не UI-копия (§17 084: промпт мимо i18n-каталога)',
  },
];

/**
 * Основы RU-каталогов и main-констант, потребляемые динамически (вне
 * params-проверки): errors.* приходит messageKey из IPC (арх. 06 §6),
 * privacy.ops.* — descriptionKey генерирует main (TASK-098).
 */
const DYNAMIC_PARAMS_PREFIXES = ['errors.', 'privacy.ops.'];

/**
 * Main-файлы RU-констант для скана запрет-корней (§5 + §13): critical-texts,
 * refusal-texts, system-prompt (§5) + 087 (дисклеймер/периоды/вопрос) + 068
 * (REPORT_RU — report.aiMark). Пути — от mainDir (apps/desktop/src).
 */
const MAIN_SCAN_FILES = [
  'main/shared/critical-texts.ts',
  'main/modules/ai-insight/application/refusal-texts.ts',
  'main/modules/ai-insight/application/prompts/system-prompt.ts',
  'main/modules/ai-insight/application/generate-summary.ts',
  'main/modules/reporting/adapters/pdf/report-strings.ts',
];

/** Рекурсивный обход каталога: файлы с расширением из набора, без node_modules/dist. */
function listFiles(dir, extensions) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`каталог не читается: ${dir}`);
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }
      files.push(...listFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.has(entry.name.split('.').pop())) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Идентичность файла в отчётах: путь от rootDir, прямые слеши (кросс-платформенно). */
function relPath(rootDir, absolutePath) {
  return relative(rootDir, absolutePath).split('\\').join('/');
}

/**
 * Запрет-корни строки (§4): id корней, найденных в тексте (без регистра).
 * Чистая функция — экспортирована для юнит-таблиц §19.
 */
export function findForbiddenRoots(text) {
  const lower = text.toLowerCase();
  return FORBIDDEN_ROOTS.filter((root) => root.pattern.test(lower)).map((root) => root.id);
}

/**
 * Строковые литералы TS-файла ('…', "…", `…`) БЕЗ комментариев (// и /* *⁄):
 * запрет-лексика в комментарии — не UI-копия. Символьный сканер: состояние
 * normal/quote/comment; экранирование внутри литерала сохраняется как есть.
 */
export function extractStringLiterals(source) {
  const literals = [];
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;
  let current = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (char === '\\') {
        current += source.slice(i, i + 2);
        i += 1;
        continue;
      }
      if (char === quote) {
        literals.push(current);
        current = '';
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current = '';
      continue;
    }
  }
  return literals;
}

/** Имена {{param}} в значении каталога (§5(3): простая проверка фигурных скобок). */
export function extractValueParams(value) {
  return [...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
}

/** Разворот каталога в плоские dot-ключи: {a:{b:"x"}} → [{key:"ns.a.b", value:"x"}]. */
export function flattenCatalogValues(catalog, namespace) {
  const flat = [];
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node)) {
      const key = `${prefix}.${name}`;
      if (value !== null && typeof value === 'object') {
        walk(value, key);
      } else if (typeof value === 'string') {
        flat.push({ key, value });
      }
    }
  };
  walk(catalog, namespace);
  return flat;
}

/**
 * Namespace ru.json: файл в каталоге `…/ru/` — по имени файла (i18n/ru/common.json
 * → common); иначе — по имени каталога (features/measurement/ru.json → measurement).
 * Семантика check-i18n (TASK-013/031).
 */
function namespaceFor(catalogPath) {
  const parent = dirname(catalogPath);
  const dirName = parent.split(/[\\/]/).pop();
  const base = catalogPath.split(/[\\/]/).pop().replace(/\.json$/, '');
  return dirName === 'ru' ? base : dirName;
}

/** Удаление комментариев из TS-исходника (строки/литералы сохраняются). */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * Имена параметров объекта-литерала t() (верхний уровень): {a: expr, b} →
 * [a, b]; {…spread} → null (параметры неизвестны — ключ выводится из строгой
 * проверки, чтобы не давать ложных находок в обе стороны).
 */
function objectParamNames(objectText) {
  const names = [];
  let depth = 0;
  let quote = null;
  let part = '';
  const parts = [];
  for (let i = 0; i < objectText.length; i += 1) {
    const char = objectText[i];
    if (quote !== null) {
      part += char;
      if (char === '\\') {
        part += objectText[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      part += char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(part);
      part = '';
      continue;
    }
    part += char;
  }
  parts.push(part);
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith('...')) {
      return null;
    }
    const keyed = /^([A-Za-z0-9_$]+)\s*:/.exec(trimmed);
    const shorthand = /^([A-Za-z0-9_$]+)\s*(?:=|$)/.exec(trimmed);
    const name = keyed?.[1] ?? shorthand?.[1];
    if (name === undefined) {
      return null;
    }
    names.push(name);
  }
  return names;
}

/**
 * Извлечение использований t(): Map<ключ, Set<параметров>> по литеральным
 * вызовам t('ns.key', { … }) в .ts/.tsx исходниках рендерера (§22: динамические
 * ключи запрещены — только литералы). Вызовы t(<expr>) без литерала дают ключ
 * undefined и не атрибутируются (их параметры неизвестны).
 */
export function extractUsages(source) {
  const usages = new Map();
  const stripped = stripComments(source);
  const callPattern = /(?<![A-Za-z0-9_$.])t\s*\(/g;
  for (const match of stripped.matchAll(callPattern)) {
    const openIndex = match.index + match[0].length - 1;
    const args = matchCallArgs(stripped, openIndex);
    if (args === null) {
      continue;
    }
    const keyLiteral = /^(['"])((?:[^\\]|\\.)*?)\1\s*$/.exec(args[0] ?? '');
    if (keyLiteral === null || args.length < 2) {
      continue;
    }
    const objectText = /^\s*\{([\s\S]*)\}\s*$/.exec(args[1]);
    if (objectText === null) {
      continue;
    }
    const names = objectParamNames(objectText[1]);
    if (names === null) {
      continue;
    }
    const key = keyLiteral[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
    const set = usages.get(key) ?? new Set();
    for (const name of names) {
      set.add(name);
    }
    usages.set(key, set);
  }
  return usages;
}

/** Аргументы вызова по индексу открывающей скобки: строки/глубина учитываются. */
function matchCallArgs(source, openIndex) {
  let depth = 0;
  let quote = null;
  let argStart = openIndex + 1;
  const args = [];
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote !== null) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const tail = source.slice(argStart, i).trim();
        if (tail.length > 0) {
          args.push(tail);
        }
        return args;
      }
      continue;
    }
    if (char === ',' && depth === 1) {
      const part = source.slice(argStart, i).trim();
      if (part.length > 0) {
        args.push(part);
      }
      argStart = i + 1;
    }
  }
  return null;
}

/** Суффиксы плюрализации i18next (ru: one/few/many/other). */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/**
 * params-дрейф по корпусу (§5(3)): значения каталогов ↔ использования t().
 * Для ключа без точного вхождения проверяется plural-группа base_suffix
 * (объединение параметров форм). Ключи динамического потребления и ключи без
 * единого использования t() — вне проверки (зона check:i18n).
 */
export function checkParams(catalogEntries, usageFiles) {
  const byKey = new Map(catalogEntries.map((entry) => [entry.key, entry]));
  const paramsByKey = new Map();
  for (const entry of catalogEntries) {
    paramsByKey.set(entry.key, extractValueParams(entry.value));
  }
  const usageParams = new Map();
  const usedKeys = new Set();
  for (const usages of usageFiles) {
    for (const [key, names] of usages) {
      usedKeys.add(key);
      const set = usageParams.get(key) ?? new Set();
      for (const name of names) {
        set.add(name);
      }
      usageParams.set(key, set);
    }
  }

  const findings = [];
  const resolveValueParams = (key) => {
    if (paramsByKey.has(key)) {
      return paramsByKey.get(key);
    }
    const group = PLURAL_SUFFIXES.map((suffix) => `${key}_${suffix}`).filter((variant) =>
      paramsByKey.has(variant),
    );
    if (group.length === 0) {
      return null;
    }
    return [...new Set(group.flatMap((variant) => paramsByKey.get(variant)))];
  };

  for (const key of usedKeys) {
    if (DYNAMIC_PARAMS_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    const valueParams = resolveValueParams(key);
    if (valueParams === null) {
      continue;
    }
    const passed = usageParams.get(key);
    for (const param of valueParams) {
      if (!passed.has(param)) {
        findings.push({
          file: byKey.get(key)?.file ?? byKey.get(`${key}_one`)?.file ?? '',
          key,
          param,
          direction: 'missing-in-usage',
        });
      }
    }
    for (const param of passed) {
      if (!valueParams.includes(param)) {
        findings.push({
          file: byKey.get(key)?.file ?? byKey.get(`${key}_one`)?.file ?? '',
          key,
          param,
          direction: 'missing-in-value',
        });
      }
    }
  }
  return findings;
}

/** Значение обязательной подстроки по записи таблицы: строка или undefined. */
function readMandatoryValue(entry, rootDir) {
  const absolutePath = join(rootDir, ...entry.file.split('/'));
  const content = readFileSync(absolutePath, 'utf8');
  if (entry.kind === 'json') {
    let catalog;
    try {
      catalog = JSON.parse(content);
    } catch {
      return undefined;
    }
    let node = catalog;
    const segments = entry.key.split('.').slice(1);
    for (const segment of segments) {
      if (node === undefined || node === null || typeof node !== 'object') {
        return undefined;
      }
      node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
  }
  if (entry.kind === 'ts-regex') {
    const match = entry.regex.exec(content);
    return match === null ? undefined : match[entry.group ?? 1];
  }
  if (entry.kind === 'ts-file') {
    return extractStringLiterals(content).join('\n');
  }
  return undefined;
}

/**
 * Полный аудит (§5): скан запрет-корней по каталогам и main-константам,
 * проверка обязательных подстрок, params-дрейф. Возвращает чистый результат —
 * печать/exit решает run().
 */
export function buildAudit(options = {}) {
  const rootDir = resolve(options.rootDir ?? DEFAULT_ROOT);
  const srcDir = resolve(options.srcDir ?? join(rootDir, DEFAULT_SRC_DIR));
  const mainDir = resolve(options.mainDir ?? join(rootDir, DEFAULT_MAIN_DIR));
  const mandatory = options.mandatory ?? MANDATORY_STRINGS;
  const whitelist = options.whitelist ?? WHITELIST;

  for (const entry of whitelist) {
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      throw new Error(
        `whitelist-запись без причины (§22: «whitelist-строки только с комментарием-причиной»): ${JSON.stringify(entry)}`,
      );
    }
  }

  const catalogFiles = listFiles(srcDir, new Set(['json'])).filter((path) =>
    path.endsWith('ru.json'),
  );
  const catalogEntries = [];
  for (const path of catalogFiles) {
    let catalog;
    try {
      catalog = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`каталог не читается (${path}): ${error.message}`);
    }
    for (const flat of flattenCatalogValues(catalog, namespaceFor(path))) {
      catalogEntries.push({ ...flat, file: relPath(rootDir, path) });
    }
  }

  const forbidden = [];
  const whitelisted = [];
  const checkText = (text, file, key) => {
    for (const root of findForbiddenRoots(text)) {
      const entry = whitelist.find(
        (candidate) =>
          candidate.file === file && candidate.root === root && text.includes(candidate.fragment),
      );
      if (entry !== undefined) {
        whitelisted.push({ file, key, root, reason: entry.reason });
        continue;
      }
      forbidden.push({ file, key, root, value: text });
    }
  };
  for (const entry of catalogEntries) {
    checkText(entry.value, entry.file, entry.key);
  }
  const mainScanned = [];
  for (const rel of MAIN_SCAN_FILES) {
    const absolutePath = join(mainDir, ...rel.split('/'));
    const content = readFileSync(absolutePath, 'utf8');
    mainScanned.push(relPath(rootDir, absolutePath));
    const literals = extractStringLiterals(content);
    for (const literal of literals) {
      checkText(literal, relPath(rootDir, absolutePath), '(main-константа)');
    }
  }

  const usageFiles = [];
  let usageFileCount = 0;
  for (const path of listFiles(srcDir, new Set(['ts', 'tsx']))) {
    if (/\.int?\.test\.(ts|tsx)$/.test(path) || /\.test\.(ts|tsx)$/.test(path)) {
      continue;
    }
    usageFileCount += 1;
    usageFiles.push(extractUsages(readFileSync(path, 'utf8')));
  }

  const mandatoryResults = mandatory.map((entry) => {
    let found;
    try {
      found = readMandatoryValue(entry, rootDir);
    } catch {
      found = undefined;
    }
    const ok =
      found !== undefined &&
      found.length > 0 &&
      (entry.mustEqual !== undefined ? found === entry.mustEqual : found.includes(entry.mustContain));
    return {
      id: entry.id,
      file: entry.file,
      ok,
      expected: entry.mustEqual ?? entry.mustContain,
      found,
      why: entry.why,
    };
  });

  const params = checkParams(
    catalogEntries,
    usageFiles,
  );

  const failed =
    forbidden.length > 0 || mandatoryResults.some((entry) => !entry.ok) || params.length > 0;
  return {
    rootDir,
    scanned: {
      catalogs: catalogFiles.length,
      catalogValues: catalogEntries.length,
      mainFiles: mainScanned.length,
      usageFiles: usageFileCount,
    },
    forbidden,
    whitelisted,
    mandatory: mandatoryResults,
    params,
    verdict: failed ? 'FAIL' : 'OK',
    exitCode: failed ? 1 : 0,
  };
}

/** Markdown-отчёт (§5: «отчёт markdown»). */
export function buildReport(audit) {
  const lines = [
    '# copy-audit — ревизия RU-текстов (TASK-110)',
    '',
    `- каталогов: ${audit.scanned.catalogs} (${audit.scanned.catalogValues} значений); main-констант: ${audit.scanned.mainFiles}; файлов использования: ${audit.scanned.usageFiles}`,
    `- verdict: ${audit.verdict}`,
    '',
    '## запрет-корни (вне whitelist)',
  ];
  if (audit.forbidden.length === 0) {
    lines.push('');
    lines.push('Находок нет.');
  } else {
    lines.push('');
    lines.push('| файл | ключ | корень | строка |');
    lines.push('|---|---|---|---|');
    for (const finding of audit.forbidden) {
      lines.push(`| ${finding.file} | ${finding.key} | ${finding.root} | ${finding.value} |`);
    }
  }
  lines.push('');
  lines.push('## whitelist-обходы (§22: каждая строка — с причиной)');
  if (audit.whitelisted.length === 0) {
    lines.push('');
    lines.push('Обходов нет.');
  } else {
    lines.push('');
    lines.push('| файл | ключ | корень | причина |');
    lines.push('|---|---|---|---|');
    for (const item of audit.whitelisted) {
      lines.push(`| ${item.file} | ${item.key} | ${item.root} | ${item.reason} |`);
    }
  }
  lines.push('');
  lines.push('## обязательные подстроки (§13: ключ → обязательная подстрока)');
  lines.push('');
  lines.push('| id | файл | ожидание | найдено | ok |');
  lines.push('|---|---|---|---|---|');
  for (const entry of audit.mandatory) {
    const found =
      entry.found === undefined ? '—' : entry.found.length > 60 ? `${entry.found.slice(0, 60)}…` : entry.found;
    lines.push(`| ${entry.id} | ${entry.file} | ${entry.expected} | ${found} | ${entry.ok ? 'ok' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## params-дрейф (§5(3): фигурные скобки, обе стороны)');
  if (audit.params.length === 0) {
    lines.push('');
    lines.push('Дрейфа нет.');
  } else {
    lines.push('');
    lines.push('| файл | ключ | параметр | направление |');
    lines.push('|---|---|---|---|');
    for (const finding of audit.params) {
      lines.push(`| ${finding.file} | ${finding.key} | ${finding.param} | ${finding.direction} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Полный прогон (§5): аудит + отчёт; exitCode — гейт §20. */
export function run(options = {}) {
  let audit;
  try {
    audit = buildAudit(options);
  } catch (error) {
    return {
      exitCode: 2,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { exitCode: audit.exitCode, report: buildReport(audit), json: audit };
}

function parseArgs(argv) {
  const args = { root: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      args.root = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--src') {
      args.src = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--main') {
      args.main = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') {
      args.json = true;
    }
  }
  return args;
}

/** CLI-вызов (node tools/scripts/copy-audit.mjs): флаги --root/--src/--main/--json. */
const scriptPath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === scriptPath) {
  const args = parseArgs(process.argv.slice(2));
  const options = {};
  if (args.root !== undefined) {
    options.rootDir = args.root;
  }
  if (args.src !== undefined) {
    options.srcDir = resolve(args.root ?? DEFAULT_ROOT, args.src);
  }
  if (args.main !== undefined) {
    options.mainDir = resolve(args.root ?? DEFAULT_ROOT, args.main);
  }
  const result = run(options);
  if (args.json) {
    console.log(JSON.stringify(result.json ?? { error: result.error }, null, 2));
  } else if (result.report !== undefined) {
    console.log(result.report);
  } else {
    console.error(result.error);
  }
  process.exitCode = result.exitCode;
}
