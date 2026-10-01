/**
 * TASK-011 §10/§16/§20: тест корневой обвязки App — контент рендерится внутри
 * boundary/тостов; полноэкранный fallback: role="alert", текст по ключу errors.renderer,
 * кнопка «Перезагрузить» в tab-порядке и перезагружает окно (§13). createElement-стиль —
 * include тест-проекта `*.test.ts` (прецедент events.test.ts).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, RendererCrashScreen } from './App';

function renderApp(): void {
  render(createElement(App));
}

function renderCrashScreen(): void {
  render(createElement(RendererCrashScreen, { messageKey: 'errors.renderer', digest: '1a2b3c4d' }));
}

beforeEach(() => {
  // TASK-047: ThemeProvider читает prefs (usePreferences → window.hl) на маунте App —
  // мост обязателен и здесь (прецедент router.test.ts).
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke: vi.fn().mockResolvedValue({ v: 1, ok: true, data: { items: [], total: 0 } }),
      on: vi.fn(() => () => undefined),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('App — корневой boundary и тосты (§5/§10)', () => {
  it('без краша показывает каркас TASK-013: провайдеры + роутер с разделами', async () => {
    renderApp();

    // Провайдеры темы/i18n/Query + HashRouter: домашний экран-сводка TASK-061
    // (мост-мок отвечает пустой БД → приветственное состояние сводки).
    // TASK-095: каркас появляется после vault/status гейта блокировки — асинхронно.
    expect(await screen.findByRole('navigation', { name: 'Разделы' })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Сводка' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('RendererCrashScreen — полноэкранный fallback (§10/§13/§16)', () => {
  it('role="alert", текст по ключу errors.renderer, кнопка «Перезагрузить»', () => {
    renderCrashScreen();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Что-то сломалось. Перезагрузите приложение.');

    const button = screen.getByRole('button', { name: 'Перезагрузить' });
    // §16: кнопка в tab-порядке — нативный button без tabindex="-1".
    expect(button.getAttribute('tabindex')).toBeNull();
  });

  it('клик по «Перезагрузить» вызывает location.reload (§13)', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });

    renderCrashScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Перезагрузить' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
