/**
 * TASK-109 §5: аудит контраста всех пар токенов темы — скрипт-расчёт по
 * tokens.css → отчёт → гейт «0 пар ниже порога» (§20 AC1). Запуск:
 * `node tools/scripts/contrast-audit.mjs [--tokens <файл>] [--json]`
 * (токены по умолчанию — apps/desktop/src-renderer/app/theme/tokens.css,
 * единственный источник значений — прецедент tokens.test.ts).
 *
 * Что считается (§13 — контраст-инвариант):
 *  - пары текст/фон, которые РЕАЛЬНО сочетаются в UI: тело/вторичный текст,
 *    статусы, инверсная кнопка (bg на accent), текст на акцентной поверхности
 *    (bg-accent/10 — активный пункт навигации);
 *  - disabled-состояния — порог 3:1 (house-rule строже exemption WCAG 1.4.3);
 *    реализация в компонентах — `disabled:opacity-80` (TASK-109: замена
 *    `disabled:opacity-50`, не дававшей 3:1 на инверсных кнопках; реальный
 *    цвет = альфа-композиция слоя по фону — считается честно, а не на глаз);
 *  - rem-масштабы (FR-8.2: 100/112.5/125%) — порог пары выбирается ПО МАСШТАБУ
 *    (§13: «на очень крупном больше пар попадают в 3:1-категорию»): крупный
 *    текст = ≥24px или ≥18.66px при весе ≥600; гейт пары — по САМОМУ строгому
 *    порогу среди масштабов (цвета от масштаба не зависят);
 *  - НЕ-текстовые границы (--hl-border, WCAG 1.4.11) — в отчёте информационно,
 *    ВНЕ гейта: §13 инвариант задаёт пороги для текста и disabled; решение по
 *    границам (отдельный токен полей ввода) — за пределами объёма TASK-109
 *    (docs/a11y-nvda.md, раздел «Находки»).
 *
 * Коды возврата: 0 — все гейт-пароны проходят; 1 — есть failing (гейт §20);
 * 2 — ошибка вызова/чтения. Зависимостей нет (node:fs). Расчёты — чистые
 * функции (§19 юнит-тесты: contrast-audit.test.mjs).
 */
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

/** Файл токенов по умолчанию (от корня монорепо; CLI запускается из корня). */
export const DEFAULT_TOKENS_PATH = 'apps/desktop/src-renderer/app/theme/tokens.css';

/** Имена токенов темы (§6: значения живут только в tokens.css). */
export const TOKEN_NAMES = [
  'bg',
  'side',
  'nav-active',
  'surface',
  'text',
  'muted',
  'accent',
  'border',
  'input-border',
  'status-ok',
  'status-fail',
  'status-warn',
];

/**
 * Rem-масштабы текста (FR-8.2 / theme/scale.css): пресеты html font-size.
 * effPx = 16px × percent/100 × sizeRem.
 */
export const SCALES = [
  { key: '100', percent: 100 },
  { key: '112', percent: 112.5 },
  { key: '125', percent: 125 },
];

/** Граница «крупного текста» WCAG 1.4.3: 18pt = 24px, 14pt bold = 18.66px. */
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;

/** Пороги AA (§13): обычный текст 4.5, крупный/disabled 3. */
const THRESHOLD_NORMAL = 4.5;
const THRESHOLD_LARGE = 3;

/**
 * Реестр пар (§5: «fg/bg комбинации»). Каждая строка — реальное сочетание в UI
 * с указанием источников (классы в компонентах). Слой (layer) — альфа-композиция
 * поверх разрешённого базового цвета: компоненты выражают состояния через
 * opacity-модификаторы Tailwind, скрипт считает результирующий цвет честно.
 *
 * Поля: fg/bg — имя токена ИЛИ {token, over, alpha}; sizeRem/weight —最大
 * типоразмер текста, на котором пара живёт (маппинг токен→размер, §13);
 * state — 'disabled' фиксирует порог 3:1; gate=false — информационная строка.
 */
export const PAIRS = [
  {
    id: 'text-on-bg',
    role: 'основной текст (body, карточки, таблицы)',
    fg: 'text',
    bg: 'bg',
    sizeRem: 1.125,
    weight: 400,
    gate: true,
    sources: 'theme.css body; text-text по всему рендереру',
  },
  {
    id: 'accent-on-bg',
    role: 'вторичный текст (легенды, подписи, подсказки)',
    fg: 'accent',
    bg: 'bg',
    sizeRem: 1,
    weight: 400,
    gate: true,
    sources: 'text-accent: подписи fieldset, футеры, hint-строки',
  },
  {
    id: 'status-ok-on-bg',
    role: 'статус «успех»',
    fg: 'status-ok',
    bg: 'bg',
    sizeRem: 0.875,
    weight: 400,
    gate: true,
    sources: 'AboutSection/ActivityFeed text-status-ok',
  },
  {
    id: 'status-fail-on-bg',
    role: 'статус «сбой»',
    fg: 'status-fail',
    bg: 'bg',
    sizeRem: 0.875,
    weight: 400,
    gate: true,
    sources: 'AboutSection/UpdatesSection text-status-fail',
  },
  {
    id: 'bg-on-accent',
    role: 'инверсная кнопка (текст bg на заливке accent)',
    fg: 'bg',
    bg: 'accent',
    sizeRem: 1,
    weight: 600,
    gate: true,
    sources: 'кнопки bg-accent text-bg (TASK-108: замена text-white)',
  },
  /* accent-on-accent10 упразднена (TASK-123 v2): активная навигация —
     filled (bg-accent + text-bg), сочетание «accent-текст на accent/10» в UI
     больше не существует; сочетание контролируется парами bg-on-accent и
     accent-on-surface. */
  {
    id: 'disabled-secondary',
    role: 'disabled вторичной кнопки (текст 50% на bg) — порог 3:1',
    fg: { token: 'text', over: 'bg', alpha: 0.9 },
    bg: 'bg',
    sizeRem: 1,
    weight: 600,
    state: 'disabled',
    gate: true,
    sources:
      'disabled:opacity-90 на вторичных кнопках (TASK-123 v2: iOS-синий светлее серого — 90%) (ExportButtons, ReportBuilder, ModelCard 239/276/311, AboutSection, DiagSection, UpdatesSection check, RecoveryScreen discard, HistoryFilters) — 3:1 выполняется уже на 50%',
  },
  {
    id: 'disabled-inverse',
    role: 'disabled инверсной кнопки (два слоя 80%) — порог 3:1',
    fg: { token: 'bg', over: { token: 'accent', over: 'bg', alpha: 0.9 }, alpha: 0.9 },
    bg: { token: 'accent', over: 'bg', alpha: 0.8 },
    sizeRem: 1,
    weight: 600,
    state: 'disabled',
    gate: true,
    sources: 'disabled:opacity-90 на bg-accent-кнопках (TASK-123 v2) (18 мест, TASK-109 §13)',
  },
  {
    id: 'disabled-accent-link',
    role: 'disabled текст-кнопки accent (80% на bg) — порог 3:1',
    fg: { token: 'accent', over: 'bg', alpha: 0.8 },
    bg: 'bg',
    sizeRem: 0.875,
    weight: 600,
    state: 'disabled',
    gate: true,
    sources: 'WipeFlow data-wipe-export disabled:opacity-80',
  },
  {
    id: 'border-on-bg',
    role: 'граница на фоне (не-текст, WCAG 1.4.11 — информационно, вне гейта)',
    fg: 'border',
    bg: 'bg',
    sizeRem: 1,
    weight: 400,
    nonText: true,
    gate: false,
    sources: 'border-border: карточки (декор), поля ввода (граница-идентификатор)',
  },
  {
    id: 'text-on-nav-active',
    role: 'текст активного раздела на пилюле (TASK-123 v3 референс: muted-pill)',
    fg: 'text',
    bg: 'nav-active',
    sizeRem: 1,
    weight: 500,
    gate: true,
    sources: 'layout.tsx NavLink active bg-nav-active text-text',
  },
  {
    id: 'muted-on-bg',
    role: 'вторичный текст на фоне (TASK-123: токен muted вместо neutral-хвостов)',
    fg: 'muted',
    bg: 'bg',
    sizeRem: 1,
    weight: 400,
    gate: true,
    sources: 'text-muted: подписи карточек, hint-строки, легенды, ChartTooltip',
  },
  {
    id: 'muted-on-surface',
    role: 'вторичный текст на поверхности карточки (TASK-123)',
    fg: 'muted',
    bg: 'surface',
    sizeRem: 1,
    weight: 400,
    gate: true,
    sources: 'text-muted внутри bg-surface карточек (ChatBubble, баннеры)',
  },
  {
    id: 'text-on-surface',
    role: 'основной текст на поверхности карточки (TASK-123)',
    fg: 'text',
    bg: 'surface',
    sizeRem: 1.125,
    weight: 400,
    gate: true,
    sources: 'text-text внутри bg-surface карточек/панелей',
  },
  {
    id: 'accent-on-surface',
    role: 'акцентный текст на поверхности (TASK-123)',
    fg: 'accent',
    bg: 'surface',
    sizeRem: 1,
    weight: 400,
    gate: true,
    sources: 'text-accent внутри bg-surface (ссылки/подписи в карточках)',
  },
  {
    id: 'input-border-on-surface',
    role: 'граница поля ввода на поверхности (не-текст 1.4.11 ≥3:1 — TASK-123/KI-4, информационно)',
    fg: 'input-border',
    bg: 'surface',
    sizeRem: 1,
    weight: 400,
    nonText: true,
    gate: false,
    sources: 'border-input-border: поля ввода форм (KI-4 закрыт)',
  },
  {
    id: 'warn-border-on-bg',
    role: 'рамка warn-баннера на фоне (не-текст ≥3:1 — TASK-123, информационно)',
    fg: 'status-warn',
    bg: 'bg',
    sizeRem: 1,
    weight: 400,
    nonText: true,
    gate: false,
    sources: 'border-status-warn/40: баннеры напоминаний (BackupReminder, ModelCard)',
  },
];

/**
 * Относительная яркость по WCAG 2.x: sRGB-канал → линейное пространство
 * (порог 0.03928 — каноническое определение WCAG 2.x, как в tokens.test.ts).
 */
export function luminance(hex) {
  const raw = hex.replace('#', '').toLowerCase();
  const weights = [0.2126, 0.7152, 0.0722];
  let sum = 0;
  for (const [index, weight] of weights.entries()) {
    const channel = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16) / 255;
    const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    sum += weight * linear;
  }
  return sum;
}

/** Контраст-коэффициент WCAG: (L1 + 0.05) / (L2 + 0.05), L1 — ярчейший. */
export function contrastRatio(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function channelToHex(value) {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Альфа-композиция sRGB (Source-over): результирующий цвет слоя fg с прозрачью
 * alpha на фоне bg. Точка отсчёта для disabled/hover-состояний, реализованных
 * opacity-модификаторами Tailwind.
 */
export function blend(fg, bg, alpha) {
  const front = fg.replace('#', '');
  const back = bg.replace('#', '');
  let hex = '#';
  for (let i = 0; i < 3; i += 1) {
    const fgChannel = Number.parseInt(front.slice(i * 2, i * 2 + 2), 16);
    const bgChannel = Number.parseInt(back.slice(i * 2, i * 2 + 2), 16);
    hex += channelToHex(fgChannel * alpha + bgChannel * (1 - alpha));
  }
  return hex;
}

/**
 * Разбор tokens.css (§5: обе темы). Блок light — `:root, [data-theme='light']`
 * (селектор-пара), dark — `[data-theme='dark']`. Отсутствующий токен — ошибка
 * с именем (тихий пропуск недопустим: молчаливый пропуск = ложный PASS).
 */
export function parseTokensCss(content) {
  function readToken(block, name) {
    const match = new RegExp(`--hl-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (match === null || match[1] === undefined) {
      throw new Error(`токен --hl-${name} не найден в tokens.css`);
    }
    return match[1].toLowerCase();
  }

  function themeBlock(theme) {
    const pattern =
      theme === 'light'
        ? /(?::root\s*,|:root)?\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/
        : /\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/;
    const match = pattern.exec(content);
    if (match === null || match[1] === undefined) {
      throw new Error(`блок темы ${theme} не найден в tokens.css`);
    }
    return match[1];
  }

  const themes = {};
  for (const theme of ['light', 'dark']) {
    const block = themeBlock(theme);
    themes[theme] = Object.fromEntries(TOKEN_NAMES.map((name) => [name, readToken(block, name)]));
  }
  return themes;
}

/**
 * Порог пары для масштаба (§13): disabled — всегда 3:1; не-текстовые пары
 * (WCAG 1.4.11, вне §13-гейта) — 3:1; крупный текст (≥24px или ≥18.66px при
 * весе ≥700 — «bold» по WCAG; 600 semibold НЕ считается крупным — трактовка
 * в строгую сторону) — 3:1; иначе 4.5. effPx = 16 × percent.
 */
export function thresholdFor(spec, scale) {
  if (spec.state === 'disabled' || spec.nonText === true) {
    return THRESHOLD_LARGE;
  }
  const effPx = 16 * (scale.percent / 100) * spec.sizeRem;
  const large = effPx >= LARGE_PX || (effPx >= LARGE_BOLD_PX && spec.weight >= 700);
  return large ? THRESHOLD_LARGE : THRESHOLD_NORMAL;
}

/** Разрешение ссылки на цвет: имя токена или слой {token, over, alpha}. */
function resolveColor(reference, themeTokens) {
  if (typeof reference === 'string') {
    const hex = themeTokens[reference];
    if (hex === undefined) {
      throw new Error(`неизвестный токен «${reference}» в реестре пар`);
    }
    return hex;
  }
  const base = resolveColor(reference.over, themeTokens);
  const layer = themeTokens[reference.token];
  if (layer === undefined) {
    throw new Error(`неизвестный токен «${reference.token}» в реестре пар`);
  }
  return blend(layer, base, reference.alpha);
}

/** Биндинг-порог пары: самый строгий среди масштабов (цвет от масштаба не зависит). */
function bindingThreshold(spec) {
  return Math.max(...SCALES.map((scale) => thresholdFor(spec, scale)));
}

/**
 * Полный расчёт (§5): каждая пара × каждая тема → ratio, порог (по биндингу),
 * ok. failing — только гейт-пароны (§20 AC1: «0 пар ниже порога»); gate=false —
 * в отчёте, на вердикт не влияет.
 */
export function evaluateReport(tokensPath) {
  const content = readFileSync(tokensPath, 'utf8');
  const themes = parseTokensCss(content);

  const pairs = PAIRS.map((spec) => {
    const threshold = bindingThreshold(spec);
    const themesResult = Object.fromEntries(
      ['light', 'dark'].map((theme) => {
        const fg = resolveColor(spec.fg, themes[theme]);
        const bg = resolveColor(spec.bg, themes[theme]);
        return [theme, { fg, bg, ratio: Math.round(contrastRatio(fg, bg) * 100) / 100 }];
      }),
    );
    const failingThemes = ['light', 'dark'].filter(
      (theme) => themesResult[theme].ratio < threshold,
    );
    return { ...spec, threshold, themes: themesResult, failingThemes };
  });

  const failing = pairs
    .filter((pair) => pair.gate && pair.failingThemes.length > 0)
    .flatMap((pair) =>
      pair.failingThemes.map((theme) => ({
        id: pair.id,
        theme,
        ratio: pair.themes[theme].ratio,
        threshold: pair.threshold,
      })),
    );

  return {
    tokensPath,
    pairs,
    failing,
    verdict: failing.length === 0 ? 'OK' : 'FAIL',
    exitCode: failing.length === 0 ? 0 : 1,
  };
}

/** Человекочитаемый отчёт (§16: dev-инструмент — английский). */
export function buildReport(report) {
  const lines = [
    'TASK-109: contrast audit (WCAG AA on tokens.css pairs, spec §13)',
    `tokens: ${report.tokensPath}`,
    `scales: ${SCALES.map((scale) => `${scale.key} (${scale.percent}%)`).join(', ')} — pair threshold = strictest across scales`,
    '',
    'pairs:',
    `  ${'id'.padEnd(22)}${'gate'.padEnd(6)}${'theme'.padEnd(7)}${'fg'.padEnd(10)}${'bg'.padEnd(10)}${'ratio'.padStart(6)}${'need'.padStart(6)}  result`,
  ];
  for (const pair of report.pairs) {
    for (const theme of ['light', 'dark']) {
      const data = pair.themes[theme];
      const ok = data.ratio >= pair.threshold;
      lines.push(
        `  ${pair.id.padEnd(22)}${(pair.gate ? 'yes' : 'info').padEnd(6)}${theme.padEnd(7)}${data.fg.padEnd(10)}${data.bg.padEnd(10)}${data.ratio.toFixed(2).padStart(6)}${pair.threshold.toFixed(1).padStart(6)}  ${ok ? 'pass' : 'FAIL'}`,
      );
    }
  }
  lines.push('');
  if (report.failing.length === 0) {
    lines.push('verdict: OK — 0 gate pairs below threshold (spec §20 AC1)');
  } else {
    lines.push(`verdict: FAIL — ${report.failing.length} gate pair(s) below threshold:`);
    for (const item of report.failing) {
      lines.push(
        `  - ${item.id} [${item.theme}]: ${item.ratio.toFixed(2)}:1 < ${item.threshold}:1`,
      );
    }
  }
  lines.push(`failing: ${report.failing.length}`);
  return lines.join('\n');
}

/** Полный прогон (§5): расчёт + отчёт; exitCode — гейт §20. */
export function run(options = {}) {
  const tokensPath = options.tokensPath ?? DEFAULT_TOKENS_PATH;
  let report;
  try {
    report = evaluateReport(tokensPath);
  } catch (error) {
    return {
      exitCode: 2,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { exitCode: report.exitCode, report: buildReport(report), json: report };
}

/** CLI-вызов (node tools/scripts/contrast-audit.mjs): флаги --tokens/--json. */
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const invokedPath = argv[1] === undefined ? undefined : realpathSync(argv[1]);
if (invokedPath === scriptPath) {
  let cliTokens;
  let cliJson = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--tokens') {
      cliTokens = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') {
      cliJson = true;
    }
  }
  const result = run({ tokensPath: cliTokens });
  if (cliJson) {
    console.log(JSON.stringify(result.json ?? { error: result.error }, null, 2));
  } else if (result.report !== undefined) {
    console.log(result.report);
  } else {
    console.error(result.error);
  }
  exit(result.exitCode);
}
