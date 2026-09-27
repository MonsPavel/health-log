/**
 * TASK-013 §10/§19/§20: рендер-тест каркаса — HashRouter, маршруты; Sidebar
 * (nav aria-label «Разделы», семантика ul > li > a) содержит 5 ссылок,
 * aria-current="page" — на активном маршруте; заголовки и обучающий пустой текст —
 * из каталога (§17); «/» и неизвестный путь ведут на /dashboard.
 * TASK-031: /journal — вкладка ввода, форма измерения вместо заглушки (§24:
 * «revert — экран-заглушка журнала восстанавливается»), остальные маршруты —
 * заглушки TASK-013. TASK-033: /journal — экран истории (список по дням), форма
 * измерения открывается кнопкой «Добавить» на той же вкладке.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from './providers';
import { AppRouter } from './router';
import { ToastProvider } from './toast';

/** Информационная архитектура §3: Динамика · Журнал · ИИ · Отчёты · Настройки. */
const SECTIONS = [
  { href: '#/dashboard', label: 'Динамика' },
  { href: '#/journal', label: 'Журнал' },
  { href: '#/ai', label: 'ИИ' },
  { href: '#/reports', label: 'Отчёты' },
  { href: '#/settings', label: 'Настройки' },
] as const;

/** Маршруты-заглушки (журнал с TASK-031 — форма ввода, не заглушка). */
const PLACEHOLDER_SECTIONS = SECTIONS.filter((section) => section.href !== '#/journal');

function renderRouterAt(hash: string): void {
  window.location.hash = hash;
  // Каркас рендерится под корневыми провайдерами — как в App (i18n init, §5;
  // ToastProvider вокруг AppProviders — прецедент App.tsx, нужен форме TASK-031).
  render(
    createElement(ToastProvider, null, createElement(AppProviders, null, createElement(AppRouter))),
  );
}

/** Мост window.hl для маршрутов с журналом (list → пустая страница; прецедент App.test.ts). */
function mockHlBridge(): void {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke: vi.fn().mockResolvedValue({ v: 1, ok: true, data: { items: [], total: 0 } }),
      on: vi.fn(() => () => undefined),
    },
  });
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('AppRouter — маршруты (§5)', () => {
  it.each(PLACEHOLDER_SECTIONS)(
    '$href: заголовок «$label» из каталога и обучающий пустой текст (FR-9.2)',
    async ({ href, label }) => {
      renderRouterAt(href);

      expect(await screen.findByRole('heading', { name: label })).not.toBeNull();
      expect(screen.getByText('Экран появится после настройки')).not.toBeNull();
    },
  );

  it('#/journal: экран истории, «Добавить» открывает форму измерения (TASK-033 §4)', async () => {
    // Мост журнала (прецедент window.hl в App.test.ts, TASK-011): list → пусто,
    // экран истории показывает пустое состояние с CTA.
    mockHlBridge();
    renderRouterAt('#/journal');

    expect(await screen.findByTestId('empty-history')).not.toBeNull();
    expect(screen.getByText('Пока нет измерений')).not.toBeNull();

    // TASK-044: в пустом состоянии две кнопки «Добавить» (шапка + CTA) — кликаем CTA.
    fireEvent.click(
      within(screen.getByTestId('empty-history')).getByRole('button', { name: 'Добавить' }),
    );

    await waitFor(() => expect(screen.getByTestId('input-sys')).not.toBeNull());
    expect(screen.getByTestId('input-dia')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Сохранить' })).not.toBeNull();
  });

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
    // Журнал монтирует HistoryScreen (TASK-033) — мост обязателен и здесь.
    mockHlBridge();
    renderRouterAt('#/journal');

    const nav = await screen.findByRole('navigation', { name: 'Разделы' });
    const journal = within(nav).getByRole('link', { name: 'Журнал' });
    expect(journal.getAttribute('aria-current')).toBe('page');

    const dashboard = within(nav).getByRole('link', { name: 'Динамика' });
    expect(dashboard.getAttribute('aria-current')).toBeNull();
  });
});
