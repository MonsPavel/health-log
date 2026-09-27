/**
 * TASK-013 §12/§13/§20 + TASK-047 §6/§10/§19: тест ThemeProvider.
 *
 * ИСТОЧНИК — prefs (каналы prefs/get|set через usePreferences, QueryClient выше):
 *  - тема/масштаб из prefs применяются к <html> (AC6 — мгновенно, без перезапуска);
 *  - до загрузки prefs — fallback на легаси-localStorage (окно pre-migration; после
 *    one-time миграции ключей нет — дефолты);
 *  - setMode вызывает канал prefs/set и НЕ пишет localStorage (AC «смена темы →
 *    html[data-theme] и вызов канала»);
 *  - system следит за prefers-color-scheme живьём (§13, подписка снимается).
 * applyPersistedAppearance — прежняя механика TASK-013 на легаси-localStorage (FOUC).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyPersistedAppearance,
  resolveTheme,
  ThemeProvider,
  TEXT_SCALE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  useTheme,
} from './ThemeProvider';

interface MqlStub {
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

function htmlTheme(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

/** Мок моста window.hl (§19) — invoke/успех prefs-каналов. */
let invoke: ReturnType<typeof vi.fn>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const DEFAULT_PREFS = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
};

/** Рендер ThemeProvider с QueryClientProvider (usePreferences требует кэш, §10). */
function renderProviders(ui: ReactNode): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

beforeEach(() => {
  localStorage.clear();
  invoke = vi.fn().mockResolvedValue(OK(DEFAULT_PREFS));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.className = '';
});

describe('ThemeProvider — источник prefs (TASK-047 §6/§10)', () => {
  it('prefs theme=dark: data-theme="dark" после загрузки prefs (AC2-семантика)', async () => {
    stubMatchMedia(false);
    invoke.mockResolvedValue(OK({ ...DEFAULT_PREFS, theme: 'dark' }));

    renderProviders(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));

    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('dark'));
    expect(htmlTheme()).toBe('dark');
    expect(invoke).toHaveBeenCalledWith('prefs/get', {});
  });

  it('prefs textScale=125: класс hl-text-125 на <html> немедленно, без перезапуска (AC6)', async () => {
    stubMatchMedia(false);
    invoke.mockResolvedValue(OK({ ...DEFAULT_PREFS, textScale: '125' }));

    renderProviders(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));

    await waitFor(() =>
      expect(document.documentElement.classList.contains('hl-text-125')).toBe(true),
    );
  });

  it('до загрузки prefs: легаси-localStorage hl.theme=dark — fallback (окно pre-migration)', () => {
    stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    invoke.mockReturnValue(new Promise(() => undefined)); // prefs/get висит

    renderProviders(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));

    expect(htmlTheme()).toBe('dark');
  });

  it('до загрузки prefs: легаси hl.textScale=125 — класс из localStorage; после prefs — из prefs', async () => {
    stubMatchMedia(false);
    localStorage.setItem(TEXT_SCALE_STORAGE_KEY, '125');
    invoke.mockReturnValue(new Promise(() => undefined));

    renderProviders(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));

    expect(document.documentElement.classList.contains('hl-text-125')).toBe(true);
    expect(document.documentElement.classList.contains('hl-text-100')).toBe(false);
  });

  it('setMode: вызывает prefs/set {patch:{theme}} и НЕ пишет localStorage (канал — источник)', async () => {
    stubMatchMedia(false);
    invoke
      .mockResolvedValueOnce(OK(DEFAULT_PREFS))
      .mockResolvedValueOnce(OK({ ...DEFAULT_PREFS, theme: 'dark' }));

    renderProviders(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'));

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { theme: 'dark' } }),
    );
    // optimistic мгновенно применил тему на <html>.
    await waitFor(() => expect(htmlTheme()).toBe('dark'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('system следит за prefers-color-scheme: смена медиа-запроса живьём меняет тему', async () => {
    const media = stubMatchMedia(false);
    renderProviders(createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'));

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

  it('подписка matchMedia снимается при unmount (нет утечки слушателей)', async () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderProviders(
      createElement(ThemeProvider, null, createElement(ThemeProbe, { next: 'dark' })),
    );
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'));

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

describe('applyPersistedAppearance — до первого рендера, легаси-localStorage (§13)', () => {
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
