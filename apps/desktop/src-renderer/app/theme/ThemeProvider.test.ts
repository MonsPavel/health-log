/**
 * TASK-013 §12/§13/§20: тест ThemeProvider — data-theme на <html> без перезагрузки,
 * режим system через matchMedia с живым переключением, выбор сохраняется в
 * localStorage (ключ hl.theme, значения system|light|dark); applyPersistedAppearance
 * применяет сохранённые тему и масштаб до первого рендера (класс на <html>, §13).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPersistedAppearance,
  resolveTheme,
  ThemeProvider,
  TEXT_SCALE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  useTheme,
} from './ThemeProvider';

interface MqlStub {
  matches: boolean;
  change(next: boolean): void;
  listenerCount(): number;
}

/** Стаб matchMedia с ручным переключением «системной» темы и подсчётом подписок. */
function stubMatchMedia(initialMatches: boolean): MqlStub {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const mql = {
    matches: initialMatches,
    addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
      listeners.delete(cb);
    },
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ ...mql, media: query, onchange: null }),
  });
  return {
    change(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) {
        cb({ matches: next });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

/** Зонд: показывает mode/resolved и переключает режим по кнопке. */
function ThemeProbe(props: { readonly next: 'system' | 'light' | 'dark' }): JSX.Element {
  const { mode, resolvedTheme, setMode } = useTheme();
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'mode' }, mode),
    createElement('span', { 'data-testid': 'resolved' }, resolvedTheme),
    createElement('button', { type: 'button', onClick: () => setMode(props.next) }, 'switch'),
  );
}

function htmlTheme(): string | undefined {
  return document.documentElement.getAttribute('data-theme');
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.className = '';
});

describe('ThemeProvider — data-theme на <html> (§5/§20)', () => {
  it('light: атрибут data-theme="light" сразу после монтирования', () => {
    stubMatchMedia(false);
    render(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));

    expect(htmlTheme()).toBe('light');
  });

  it('system + системная тёмная: resolved dark без перезагрузки (§13)', () => {
    stubMatchMedia(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'light' })));

    expect(htmlTheme()).toBe('dark');
    expect(screen.getByTestId('mode').textContent).toBe('system');
  });

  it('переключение system→dark→light меняет атрибут и пишет hl.theme в localStorage', () => {
    stubMatchMedia(false);
    const view = render(
      createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(htmlTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // rerender меняет целевой режим зонда, оставаясь в том же дереве (один провайдер).
    view.rerender(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'light' })));
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(htmlTheme()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('system следит за prefers-color-scheme: смена медиа-запроса живьём меняет тему', () => {
    const media = stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));

    expect(htmlTheme()).toBe('light');
    act(() => {
      media.change(true);
    });
    expect(htmlTheme()).toBe('dark');
    act(() => {
      media.change(false);
    });
    expect(htmlTheme()).toBe('light');
  });

  it('подписка matchMedia снимается при unmount (нет утечки слушателей)', () => {
    const media = stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const { unmount } = render(
      createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })),
    );

    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});

describe('resolveTheme — system → светлая/тёмная по системе (§13)', () => {
  it('system: тёмная при matches, светлая иначе; явные режимы — как заданы', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('applyPersistedAppearance — до первого рендера (§13)', () => {
  it('тема из localStorage ставится атрибутом на <html>', () => {
    stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    applyPersistedAppearance();

    expect(htmlTheme()).toBe('dark');
  });

  it('масштаб из hl.textScale ставит класс на <html> (FR-8.2)', () => {
    stubMatchMedia(false);
    localStorage.setItem(TEXT_SCALE_STORAGE_KEY, '125');

    applyPersistedAppearance();

    expect(document.documentElement.classList.contains('hl-text-125')).toBe(true);
  });

  it('мусор в localStorage и его отсутствие — безопасные дефолты (light, 100%)', () => {
    stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'hacker-mode"');

    applyPersistedAppearance();

    expect(htmlTheme()).toBe('light');
    expect(document.documentElement.classList.contains('hl-text-100')).toBe(true);
  });
});
