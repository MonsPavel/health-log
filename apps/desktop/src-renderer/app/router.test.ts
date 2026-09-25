/**
 * TASK-013 §10/§19/§20: рендер-тест каркаса — HashRouter, 5 маршрутов-заглушек;
 * Sidebar (nav aria-label «Разделы», семантика ul > li > a) содержит 5 ссылок,
 * aria-current="page" — на активном маршруте; заголовки и обучающий пустой текст —
 * из каталога (§17); «/» и неизвестный путь ведут на /dashboard.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProviders } from './providers';
import { AppRouter } from './router';

/** Информационная архитектура §3: Динамика · Журнал · ИИ · Отчёты · Настройки. */
const SECTIONS = [
  { href: '#/dashboard', label: 'Динамика' },
  { href: '#/journal', label: 'Журнал' },
  { href: '#/ai', label: 'ИИ' },
  { href: '#/reports', label: 'Отчёты' },
  { href: '#/settings', label: 'Настройки' },
] as const;

function renderRouterAt(hash: string): void {
  window.location.hash = hash;
  // Каркас рендерится под корневыми провайдерами — как в App (i18n init, §5).
  render(createElement(AppProviders, null, createElement(AppRouter)));
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('AppRouter — пять маршрутов-заглушек (§5)', () => {
  it.each(SECTIONS)(
    '$href: заголовок «$label» из каталога и обучающий пустой текст (FR-9.2)',
    async ({ href, label }) => {
      renderRouterAt(href);

      expect(await screen.findByRole('heading', { name: label })).not.toBeNull();
      expect(screen.getByText('Экран появится после настройки')).not.toBeNull();
    },
  );

  it('«/» перенаправляет на /dashboard', async () => {
    renderRouterAt('#/');

    expect(await screen.findByRole('heading', { name: 'Динамика' })).not.toBeNull();
  });

  it('неизвестный путь перенаправляет на /dashboard', async () => {
    renderRouterAt('#/nope');

    expect(await screen.findByRole('heading', { name: 'Динамика' })).not.toBeNull();
  });
});

describe('Sidebar — семантика и активный раздел (§10/§16)', () => {
  it('nav aria-label «Разделы», 5 ссылок ul>li>a в порядке информационной архитектуры', async () => {
    renderRouterAt('#/dashboard');

    const nav = await screen.findByRole('navigation', { name: 'Разделы' });
    const list = within(nav).getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);

    for (const [index, section] of SECTIONS.entries()) {
      const item = items[index];
      if (item === undefined) {
        throw new Error(`пункт меню ${section.label} не найден`);
      }
      const link = within(item).getByRole('link', { name: section.label });
      expect(link.getAttribute('href')).toBe(section.href);
    }
  });

  it('активный раздел помечен aria-current="page", остальные — нет', async () => {
    renderRouterAt('#/journal');

    const nav = await screen.findByRole('navigation', { name: 'Разделы' });
    const journal = within(nav).getByRole('link', { name: 'Журнал' });
    expect(journal.getAttribute('aria-current')).toBe('page');

    const dashboard = within(nav).getByRole('link', { name: 'Динамика' });
    expect(dashboard.getAttribute('aria-current')).toBeNull();
  });
});
