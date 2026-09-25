/**
 * TASK-011 §10/§16/§20: тест корневой обвязки App — контент рендерится внутри
 * boundary/тостов; полноэкранный fallback: role="alert", текст по ключу errors.renderer,
 * кнопка «Перезагрузить» в tab-порядке и перезагружает окно (§13). createElement-стиль —
 * include тест-проекта `*.test.ts` (прецедент events.test.ts).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, RendererCrashScreen } from './App';

function renderApp(): void {
  render(createElement(App));
}

function renderCrashScreen(): void {
  render(createElement(RendererCrashScreen, { messageKey: 'errors.renderer', digest: '1a2b3c4d' }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('App — корневой boundary и тосты (§5/§10)', () => {
  it('без краша показывает обычный контент каркаса', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Health Log' })).toBeDefined();
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
