/**
 * TASK-048 §5/§6/§19: юнит-тест масштаб-классов крупного режима текста.
 *
 * Источник правил — theme/scale.css (единственный источник, §6 «создать»): три
 * пресета FR-8.2 (100 / 112.5 / 125) как font-size на <html>; классы ставит
 * ThemeProvider (prefs.textScale — TASK-047), CSS-сторона проверяется здесь по
 * тексту файлов (прецедент tokens.test.ts — файл разбирается регулярками).
 *
 * theme.css обязан импортировать scale.css — иначе классы не попадут в бандл
 * (точка входа CSS — theme.css, main.tsx импортирует только его и tokens.css).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME_DIR = resolve(process.cwd(), 'apps', 'desktop', 'src-renderer', 'app', 'theme');

const SCALE_PATH = resolve(THEME_DIR, 'scale.css');
const THEME_PATH = resolve(THEME_DIR, 'theme.css');
const TOKENS_PATH = resolve(THEME_DIR, 'tokens.css');

describe('scale.css — масштаб-классы html (TASK-048 §6, FR-8.2)', () => {
  it('файл scale.css существует и объявляет базу 100% и классы 112/125', () => {
    const content = readFileSync(SCALE_PATH, 'utf8');
    expect(content).toMatch(/html\s*\{\s*font-size:\s*100%/);
    expect(content).toMatch(/html\.hl-text-112\s*\{\s*font-size:\s*112\.5%/);
    expect(content).toMatch(/html\.hl-text-125\s*\{\s*font-size:\s*125%/);
  });

  it('три пресета — ровно по одному правилу на класс (без дублей-источников)', () => {
    const content = readFileSync(SCALE_PATH, 'utf8');
    expect(content.match(/html\.hl-text-112\s*\{/g)?.length).toBe(1);
    expect(content.match(/html\.hl-text-125\s*\{/g)?.length).toBe(1);
  });

  it('theme.css импортирует scale.css (классы попадают в бандл)', () => {
    const content = readFileSync(THEME_PATH, 'utf8');
    expect(content).toMatch(/@import\s+['"]\.\/scale\.css['"]/);
  });

  it('tokens.css больше не содержит масштаб-правил (перенос завершён — один источник)', () => {
    const content = readFileSync(TOKENS_PATH, 'utf8');
    expect(content).not.toMatch(/hl-text-1/);
    expect(content).not.toMatch(/font-size/);
  });
});
