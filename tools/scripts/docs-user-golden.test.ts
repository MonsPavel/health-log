/**
 * TASK-113 §13/§14/§16/§20: golden-тест руководства пользователя docs/user.
 * Автоматическая доля приёмки (§20/§24 — ручной «новичок-тест» остаётся главным):
 *  - все 7 страниц существуют; оглавление-линки работают (AC-1);
 *  - границы продукта: «не является медицинской консультацией» — присутствует (AC-6, golden);
 *  - anti-phishing строка §14 («мы никогда не попросим ваш пароль в чате»);
 *  - FAQ покрывает 4 обязательных вопроса §5 (AC-3);
 *  - пароль копии ≠ пароль приложения — явное разъяснение (§13);
 *  - скриншоты: ссылки на img/* существуют, alt-тексты непустые и не имена файлов (AC-5);
 *  - тон §13: без паник-лексики (корпус — прецедент RecoveryScreen golden §17);
 *  - шаги пронумерованы (§16: шаги-списки) на страницах-инструкциях.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Корень руководства от этого файла: tools/scripts → два уровня вверх → docs/user. */
const USER_DOCS_DIR = fileURLToPath(new URL('../../docs/user', import.meta.url));

const PAGES = ['index', 'install', 'daily', 'ai', 'data', 'privacy', 'faq'] as const;

function read(page: string): string {
  return readFileSync(join(USER_DOCS_DIR, `${page}.md`), 'utf8');
}

const all = (): Record<string, string> =>
  Object.fromEntries(PAGES.map((page) => [page, read(page)]));

/** Markdown-ссылки на .md внутри руководства (внешние http(s) и якоря — вне теста). */
function internalDocLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? '';
    if (/^https?:\/\//.test(target) || target.startsWith('#')) {
      continue;
    }
    links.push(target.split('#')[0] ?? '');
  }
  return links.filter((target) => target.endsWith('.md'));
}

/** Markdown-картинки: [alt](путь). */
function images(markdown: string): Array<{ alt: string; path: string }> {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({
    alt: m[1] ?? '',
    path: m[2] ?? '',
  }));
}

describe('docs/user — состав руководства (TASK-113 §5, AC-1)', () => {
  it('все 7 страниц существуют и не пусты', () => {
    for (const page of PAGES) {
      const markdown = read(page);
      expect(markdown.trim().length, `docs/user/${page}.md`).toBeGreaterThan(200);
    }
  });

  it('каждая страница начинается с заголовка H1', () => {
    for (const page of PAGES) {
      expect(read(page), page).toMatch(/^# /);
    }
  });

  it('оглавление-линки работают: каждая внутренняя .md-ссылка ведёт на существующий файл (AC-1)', () => {
    for (const page of PAGES) {
      for (const target of internalDocLinks(read(page))) {
        const resolved = join(USER_DOCS_DIR, target);
        expect(() => readFileSync(resolved, 'utf8'), `${page} → ${target}`).not.toThrow();
      }
    }
  });

  it('index — оглавление: ссылается на остальные 6 страниц', () => {
    const targets = internalDocLinks(read('index'));
    for (const page of PAGES.filter((p) => p !== 'index')) {
      expect(
        targets.some((t) => t.includes(page)),
        `index → ${page}.md`,
      ).toBe(true);
    }
  });
});

describe('docs/user — границы продукта и безопасное поведение (§13/§14, AC-6 golden)', () => {
  it('«не является медицинской консультацией» — присутствует (ai, faq, index)', () => {
    for (const page of ['ai', 'faq', 'index'] as const) {
      expect(read(page), page).toContain('не является медицинской консультацией');
    }
  });

  it('anti-phishing строка §14: «мы никогда не попросим ваш пароль» (data, faq)', () => {
    for (const page of ['data', 'faq'] as const) {
      expect(read(page), page).toMatch(/мы никогда не попросим ваш пароль/i);
    }
  });

  it('пароль копии ≠ пароль приложения — явное разъяснение (§13)', () => {
    const data = read('data');
    expect(data).toMatch(/парол[ья]\s+копи/i);
    expect(data).toMatch(/пароль приложени/i);
    expect(data).toMatch(/разные пароли/i);
  });
});

describe('docs/user — FAQ покрывает 4 обязательных вопроса §5 (AC-3)', () => {
  const faq = read('faq');

  it('1–2: забыл пароль приложения; забыл пароль копии (раздельно)', () => {
    expect(faq).toMatch(/пароль приложени/i);
    expect(faq).toMatch(/парол[ья]\s+копи/i);
  });

  it('3: пропустил измерения — без вины (FR-4.4)', () => {
    expect(faq).toMatch(/пропустил|пропуск/i);
    expect(faq).toMatch(/без вины|это нормально|ничего страшного/i);
  });

  it('4: 190/120 — панель критических значений + 103 (FR-7.4)', () => {
    expect(faq).toMatch(/190\s*\/\s*120|180\s*\/\s*120/);
    expect(faq).toMatch(/103/);
  });

  it('5: нашёл баг — диагностический пакет (TASK-103)', () => {
    expect(faq).toMatch(/диагност/i);
  });
});

describe('docs/user — скриншоты и структура (§5/§16, AC-5)', () => {
  it('файлы картинок существуют в docs/user/img, alt непустой и не имя файла', () => {
    let total = 0;
    for (const page of PAGES) {
      for (const image of images(read(page))) {
        total += 1;
        expect(image.alt.trim().length, `${page}: alt «${image.alt}»`).toBeGreaterThan(10);
        expect(image.alt, `${page}: alt — не имя файла`).not.toMatch(/\.(png|jpe?g|gif)$/i);
        expect(
          readdirSync(join(USER_DOCS_DIR, 'img')).some(
            (f) => f === image.path.replace(/^img\//, ''),
          ),
          `${page}: ${image.path}`,
        ).toBe(true);
      }
    }
    expect(total, 'руководство содержит скриншоты').toBeGreaterThanOrEqual(4);
  });

  it('инструкции — пронумерованные шаги (install/daily/data/privacy/ai, §16)', () => {
    for (const page of ['install', 'daily', 'data', 'privacy', 'ai'] as const) {
      expect(read(page), page).toMatch(/(^|\n)1\. /);
    }
  });
});

describe('docs/user — тон §13 (golden, прецедент RecoveryScreen §17)', () => {
  it('без паник-лексики на всех страницах', () => {
    // Корпус docs — не копия UI-каталога: слова «ошибка»/«сбой»/«критическое»
    // в руководстве — фактические статусы и отметки интерфейса (лента сети,
    // журнал), панику выражают катастрофизирующие формулы и CAPS-серии.
    const panic = /(ФАТАЛЬН|КРАШ|!!!|УТЕРЯНЫ НАВСЕГДА|СЛОМАНО? НАВСЕГДА|НИКУДА НЕ ГОДИТСЯ)/i;
    const docs = all();
    for (const page of PAGES) {
      const offenders = docs[page]?.split('\n').filter((line) => panic.test(line)) ?? [];
      expect(offenders, `${page}: ${offenders.join(' | ')}`).toEqual([]);
    }
  });

  it('в index — чек-лист тона в шапке (§13)', () => {
    expect(read('index')).toMatch(/Тон этого руководства/);
  });
});
