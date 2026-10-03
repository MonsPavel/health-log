/**
 * TASK-109 §19: юнит-тесты скрипта аудита контраста токенов.
 *
 * Слои (прецедент size-audit.test.mjs — расчёты отделены от ФС):
 *  1. WCAG-формула — эталонные пары из публикации WCAG 2.x / WebAIM (известные
 *     значения: 21:1 чёрное/белое, 3.95:1 #808080/белое, 4.54:1 #767676/белое,
 *     8.59:1 #0000FF/белое) — формула сверяется с внешними константами, а не с
 *     самой собой;
 *  2. альфа-композиция (disabled/hover-поверхности) — blend(#000, #FFF, 0.5) =
 *     #808080 (связка с эталоном п.1);
 *  3. парсер tokens.css — источник значений ЕДИНСТВЕННЫЙ: реальный файл темы
 *     (прецедент tokens.test.ts), обе темы, 6 токенов;
 *  4. пороги — размер/вес текста → 4.5 или 3:1, rem-масштабы 100/112.5/125
 *     (§13: «на очень крупном больше пар попадают в 3:1-категорию»); disabled —
 *     всегда 3:1;
 *  5. ГЕЙТ §19/§20 — полный отчёт по реальным токенам: 0 гейт-пар ниже порога
 *     (после правок TASK-109); не-текстовые границы (WCAG 1.4.11) — вне гейта,
 *     только в отчёте;
 *  6. CLI — exit-код и --json (§20: вывод парсится JSON.parse).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  SCALES,
  blend,
  buildReport,
  contrastRatio,
  evaluateReport,
  luminance,
  parseTokensCss,
  run,
  thresholdFor,
} from './contrast-audit.mjs';

/** Скрипт для CLI-тестов (§20: --json разбирается JSON.parse без ошибок). */
const SCRIPT_PATH = fileURLToPath(new URL('./contrast-audit.mjs', import.meta.url));

/** Реальный tokens.css — единственный источник значений (§5). */
const TOKENS_PATH = fileURLToPath(
  new URL('../../apps/desktop/src-renderer/app/theme/tokens.css', import.meta.url),
);

/** Точность сравнения с эталонами публикаций: 0.01 абсолютных единиц ratio. */
const RATIO_EPSILON = 0.01;

/** Tmp-каталоги фикстур; удаляются после прогона (§13: без следов). */
const tmpRoots = [];
afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpTokensCss(content) {
  const dir = await mkdtemp(join(tmpdir(), 'hl-contrast-'));
  tmpRoots.push(dir);
  const path = join(dir, 'tokens.css');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('WCAG-формула (§19: эталонные пары публикаций)', () => {
  it('luminance: #000000 = 0, #FFFFFF = 1', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBe(1);
  });

  it('luminance: #808080 ≈ 0.21586 (серая шкала WCAG)', () => {
    expect(luminance('#808080')).toBeCloseTo(0.21586, 4);
  });

  it('contrastRatio: чёрное/белое = 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 3);
  });

  it('contrastRatio: симметрична — (a,b) = (b,a)', () => {
    expect(contrastRatio('#475569', '#f8fafc')).toBeCloseTo(
      contrastRatio('#f8fafc', '#475569'),
      12,
    );
  });

  it.each([
    ['#ffffff', '#808080', 3.95], // публикация WCAG/WebAIM: серый 50% на белом
    ['#ffffff', '#767676', 4.54], // «самый тёмный AA-серый на белом»
    ['#ffffff', '#0000ff', 8.59], // синий на белом (пример WCAG)
  ])('contrastRatio(#%s, #%s) = %s:1 — эталон', (fg, bg, expected) => {
    expect(contrastRatio(fg, bg)).toBeCloseTo(expected, 2);
  });

  it('contrastRatio: порог AA — #767676 на белом проходит 4.5, #777777 — нет', () => {
    expect(contrastRatio('#ffffff', '#767676')).toBeGreaterThanOrEqual(4.5 - RATIO_EPSILON);
    expect(contrastRatio('#ffffff', '#777777')).toBeLessThan(4.5);
  });
});

describe('альфа-композиция (§13: disabled/hover-поверхности)', () => {
  it('blend: alpha=0 → фон, alpha=1 → передний план', () => {
    expect(blend('#000000', '#ffffff', 0)).toBe('#ffffff');
    expect(blend('#000000', '#ffffff', 1)).toBe('#000000');
  });

  it('blend: чёрный 50% на белом = #808080 (связка с эталоном 3.95:1)', () => {
    expect(blend('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(contrastRatio(blend('#000000', '#ffffff', 0.5), '#ffffff')).toBeCloseTo(3.95, 2);
  });

  it('blend: округление до hex-каналов детерминировано', () => {
    // 25% чёрного на белом: 191.25 → 191 = 0xbf (banker's-спор не возникает:
    // дробная часть .25/.75 округляется к чётному каналу, фиксируем факт).
    expect(blend('#000000', '#ffffff', 0.25)).toBe('#bfbfbf');
  });
});

describe('парсер tokens.css (§5: единственный источник значений)', () => {
  const tokens = parseTokensCss(readFileSync(TOKENS_PATH, 'utf8'));

  it('обе темы, все шесть токенов в hex (§6: fg/bg комбинации)', () => {
    for (const theme of ['light', 'dark']) {
      expect(Object.keys(tokens[theme]).sort()).toEqual(
        ['accent', 'bg', 'border', 'status-fail', 'status-ok', 'text'].sort(),
      );
      for (const value of Object.values(tokens[theme])) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('значения совпадают с задокументированными в tokens.css (срез)', () => {
    expect(tokens.light.text).toBe('#0f172a');
    expect(tokens.light.bg).toBe('#f8fafc');
    expect(tokens.dark.text).toBe('#f1f5f9');
    expect(tokens.dark.bg).toBe('#0f172a');
  });

  it('отсутствующий токен — ошибка с именем токена', () => {
    const content = ":root, [data-theme='light'] { --hl-bg: #ffffff; }";
    expect(() => parseTokensCss(content)).toThrow(/--hl-text/);
  });
});

describe('пороги (§13): размер × вес × rem-масштаб', () => {
  it('обычный текст (1rem/400) — 4.5 на всех трёх масштабах', () => {
    for (const scale of SCALES) {
      expect(thresholdFor({ sizeRem: 1, weight: 400 }, scale)).toBe(4.5);
    }
  });

  it('«очень крупный» (125%) поднимает text-sm (0.875rem) до 17.5px — всё ещё 4.5', () => {
    const veryLarge = SCALES.find((scale) => scale.percent === 125);
    expect(thresholdFor({ sizeRem: 0.875, weight: 400 }, veryLarge)).toBe(4.5);
  });

  it('крупный текст: 1.25rem/600 на 125% (25px) — 3:1, на 100% (20px) — 4.5', () => {
    expect(thresholdFor({ sizeRem: 1.25, weight: 600 }, SCALES[0])).toBe(4.5);
    expect(thresholdFor({ sizeRem: 1.25, weight: 600 }, SCALES[2])).toBe(3);
  });

  it('крупный текст без веса: 1.5rem/400 (24px на 100%) — 3 на всех масштабах', () => {
    for (const scale of SCALES) {
      expect(thresholdFor({ sizeRem: 1.5, weight: 400 }, scale)).toBe(3);
    }
  });

  it('disabled — всегда 3:1 независимо от размера (§13)', () => {
    expect(thresholdFor({ sizeRem: 1, weight: 400, state: 'disabled' }, SCALES[0])).toBe(3);
    expect(thresholdFor({ sizeRem: 0.875, weight: 600, state: 'disabled' }, SCALES[2])).toBe(3);
  });
});

describe('ГЕЙТ (§19/§20): полный отчёт по реальным токенам', () => {
  const report = evaluateReport(TOKENS_PATH);

  it('каждая пара отчёта: значения resolvenся из токенов обеих тем', () => {
    for (const pair of report.pairs) {
      for (const theme of ['light', 'dark']) {
        expect(pair.themes[theme].fg).toMatch(/^#[0-9a-f]{6}$/);
        expect(pair.themes[theme].bg).toMatch(/^#[0-9a-f]{6}$/);
        expect(pair.themes[theme].ratio).toBeGreaterThan(1);
      }
    }
  });

  it('0 гейт-пар ниже порога (§20 AC1 — после правок TASK-109)', () => {
    expect(report.failing).toEqual([]);
  });

  it('не-текстовые границы (WCAG 1.4.11) — в отчёте, вне гейта, порог 3:1', () => {
    const borderPair = report.pairs.find((pair) => pair.id === 'border-on-bg');
    expect(borderPair).toBeDefined();
    expect(borderPair.gate).toBe(false);
    expect(borderPair.threshold).toBe(3);
  });

  it('отчёт текстом: таблица пар + вердикт + счётчик failing', () => {
    const text = buildReport(report);
    expect(text).toContain('TASK-109: contrast audit');
    expect(text).toContain('text-on-bg');
    expect(text).toContain('verdict:');
    expect(text).toContain(`failing: ${report.failing.length}`);
  });
});

describe('CLI (§20: exit-код + --json)', () => {
  function cli(args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, ...args]);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('close', (code) => {
        resolve({ code, stdout });
      });
    });
  }

  it('реальные токены после правок: exit 0, отчёт печатается', async () => {
    const { code, stdout } = await cli([]);
    expect(code).toBe(0);
    expect(stdout).toContain('verdict: OK');
  });

  it('--json парсится и содержит failing-список (§20)', async () => {
    const { code, stdout } = await cli(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('failing');
    expect(parsed).toHaveProperty('verdict');
  });

  it('неудовлетворяющая пара в фикстуре → exit 1 и упоминание пары', async () => {
    const path = await tmpTokensCss(
      [
        ":root, [data-theme='light'] {",
        '  --hl-bg: #f8fafc;',
        '  --hl-text: #94a3b8;', // slate-400 на slate-50 — заведомо ниже 4.5
        '  --hl-accent: #475569;',
        '  --hl-border: #cbd5e1;',
        '  --hl-status-ok: #15803d;',
        '  --hl-status-fail: #b91c1c;',
        '}',
        "[data-theme='dark'] {",
        '  --hl-bg: #0f172a;',
        '  --hl-text: #f1f5f9;',
        '  --hl-accent: #cbd5e1;',
        '  --hl-border: #334155;',
        '  --hl-status-ok: #4ade80;',
        '  --hl-status-fail: #f87171;',
        '}',
        '',
      ].join('\n'),
    );
    const { code, stdout } = await cli(['--tokens', path, '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.verdict).toBe('FAIL');
    expect(parsed.failing.length).toBeGreaterThan(0);
    expect(parsed.failing.some((pair) => pair.id === 'text-on-bg' && pair.theme === 'light')).toBe(
      true,
    );
  });

  it('нет файла токенов → exit 2 (ошибка вызова)', async () => {
    const { code } = await cli(['--tokens', join(tmpdir(), 'hl-nope-tokens.css')]);
    expect(code).toBe(2);
  });
});

describe('сведéние: пары реального отчёта (срез, обе темы)', () => {
  const report = evaluateReport(TOKENS_PATH);

  it('инверсная пара (кнопка) обеих тем ≥ 4.5 (§13)', () => {
    const pair = report.pairs.find((entry) => entry.id === 'bg-on-accent');
    expect(pair.themes.light.ratio).toBeGreaterThanOrEqual(4.5);
    expect(pair.themes.dark.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('disabled-состояния обеих тем ≥ 3 (§13; реализация — см. registry в скрипте)', () => {
    for (const id of ['disabled-secondary', 'disabled-inverse']) {
      const pair = report.pairs.find((entry) => entry.id === id);
      expect(pair?.gate).toBe(true);
      expect(pair.themes.light.ratio).toBeGreaterThanOrEqual(3);
      expect(pair.themes.dark.ratio).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('run() (§5: «отчёт»)', () => {
  it('run() на реальных токенах: exit 0, текст отчёта с вердиктом OK, json без failing', async () => {
    const result = await run({ tokensPath: TOKENS_PATH });
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain('verdict: OK');
    expect(result.json.failing).toEqual([]);
    expect(result.json.verdict).toBe('OK');
  });
});
