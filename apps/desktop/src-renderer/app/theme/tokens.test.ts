/**
 * TASK-013 §16/§20: контраст-тест токенов — пары текст/фон и акцент/фон обеих тем
 * ≥ 4.5:1 (WCAG AA). Токены читаются из tokens.css (единственный источник значений):
 * файл разбирается по блокам [data-theme='…'] и :root (дефолт = light).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOKENS_PATH = resolve(
  process.cwd(),
  'apps',
  'desktop',
  'src-renderer',
  'app',
  'theme',
  'tokens.css',
);

interface ThemeTokens {
  readonly bg: string;
  readonly text: string;
  readonly accent: string;
  readonly statusOk: string;
  readonly statusFail: string;
}

/** Относительная яркость по WCAG 2.x: sRGB-канал → линейное пространство. */
function luminance(hex: string): number {
  const raw = hex.replace('#', '');
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
function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Разбор блока CSS-переменных: {bg,text,accent,statusOk,statusFail} в hex. */
function parseTokens(block: string): ThemeTokens {
  const read = (name: string): string => {
    const match = new RegExp(`--hl-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (match === null || match[1] === undefined) {
      throw new Error(`токен --hl-${name} не найден в блоке tokens.css`);
    }
    return match[1];
  };
  return {
    bg: read('bg'),
    text: read('text'),
    accent: read('accent'),
    statusOk: read('status-ok'),
    statusFail: read('status-fail'),
  };
}

function themeBlock(theme: 'light' | 'dark'): string {
  const content = readFileSync(TOKENS_PATH, 'utf8');
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

describe.each(['light', 'dark'] as const)('токены темы %s — контраст AA (§16/§20)', (theme) => {
  const tokens = parseTokens(themeBlock(theme));

  it(`текст на фоне ≥ 4.5:1 (${tokens.text} на ${tokens.bg})`, () => {
    expect(contrastRatio(tokens.text, tokens.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it(`акцент на фоне ≥ 4.5:1 (${tokens.accent} на ${tokens.bg})`, () => {
    expect(contrastRatio(tokens.accent, tokens.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it(`статус «успех» на фоне ≥ 4.5:1 (${tokens.statusOk} на ${tokens.bg})`, () => {
    expect(contrastRatio(tokens.statusOk, tokens.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it(`статус «сбой» на фоне ≥ 4.5:1 (${tokens.statusFail} на ${tokens.bg})`, () => {
    expect(contrastRatio(tokens.statusFail, tokens.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('tokens.css — структура (§5)', () => {
  it('обе темы объявлены, у каждой все шесть токенов (bg/text/accent/border/status-ok/status-fail)', () => {
    for (const theme of ['light', 'dark'] as const) {
      const block = themeBlock(theme);
      for (const token of ['bg', 'text', 'accent', 'border', 'status-ok', 'status-fail']) {
        expect(new RegExp(`--hl-${token}:\\s*#[0-9a-fA-F]{6}`).test(block)).toBe(true);
      }
    }
  });

  // Rem-масштаб текста (классы hl-text-*) — с TASK-048 тестируется в scale.test.ts.
});
