/**
 * TASK-047 §5/§16/§19: UI-тест секции «Вид» — полная цепочка «клик → usePreferences
 * (optimistic) → ThemeProvider → <html>» с моком каналов (§19 матрица):
 *  - контролы отражают prefs (тёмная checked, масштаб, формат);
 *  - смена темы → вызов канала prefs/set И html[data-theme] (AC);
 *  - смена масштаба → класс hl-text-* на <html> сразу (AC6);
 *  - select формата даты → prefs/set; пример перерисовывается под пресет;
 *  - отказ сохранения: optimistic-откат — checked и <html> вернулись (§10).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { ThemeProvider } from '../../../app/theme/ThemeProvider';
import { AppearanceSection } from './AppearanceSection';

let invoke: ReturnType<typeof vi.fn>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const PREFS = (over: Record<string, unknown> = {}) => ({
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
  ...over,
});

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ThemeProvider, null, createElement(AppearanceSection)),
    ) as ReactNode,
  );
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK(PREFS()));
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

describe('AppearanceSection — секция «Вид» (§5/§16)', () => {
  it('контролы отражают prefs: тёмная checked, масштаб 100, формат auto; секция подписана легендой', async () => {
    invoke.mockResolvedValue(OK(PREFS({ theme: 'dark' })));
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Тёмная' }).checked).toBe(true),
    );
    expect(screen.getByRole('group', { name: 'Тема' })).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Обычный' }).checked).toBe(true);
    expect(
      (screen.getByLabelText('Формат даты') as HTMLSelectElement).value,
    ).toBe('auto');
  });

  it('клик «Светлая»: prefs/set {patch:{theme}} и html[data-theme="light"] (AC)', async () => {
    invoke.mockResolvedValue(OK(PREFS({ theme: 'dark' })));
    renderSection();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Тёмная' }).checked).toBe(true));

    invoke.mockResolvedValueOnce(OK(PREFS({ theme: 'light' })));
    fireEvent.click(screen.getByRole('radio', { name: 'Светлая' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { theme: 'light' } }),
    );
    // optimistic применил тему к <html> немедленно (прецедент ThemeProvider).
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
  });

  it('клик «Крупный» (112.5): prefs/set и класс hl-text-112 на <html> мгновенно (AC6)', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Обычный' }).checked).toBe(true));

    invoke.mockResolvedValueOnce(OK(PREFS({ textScale: '112.5' })));
    fireEvent.click(screen.getByRole('radio', { name: 'Крупный' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { textScale: '112.5' } }),
    );
    await waitFor(() =>
      expect(document.documentElement.classList.contains('hl-text-112')).toBe(true),
    );
  });

  it('select формата даты: prefs/set {patch:{dateFormat}}; пример перерисовался под пресет', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByLabelText('Формат даты')).toBeDefined());

    invoke.mockResolvedValueOnce(OK(PREFS({ dateFormat: 'mdy' })));
    fireEvent.change(screen.getByLabelText('Формат даты'), { target: { value: 'mdy' } });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { dateFormat: 'mdy' } }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('date-format-preview').textContent).toContain('01/31/2026'),
    );
  });

  it('отказ сохранения: optimistic-откат — checked и <html> вернулись (§10)', async () => {
    invoke.mockResolvedValue(OK(PREFS({ theme: 'dark' })));
    renderSection();
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark'),
    );

    invoke.mockResolvedValueOnce({
      v: 1,
      ok: false,
      error: { code: 'STORAGE/FAILED', messageKey: 'errors.STORAGE_FAILED' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Светлая' }));

    await waitFor(() => expect(screen.getByText('Не удалось сохранить настройку — значение возвращено')).toBeDefined());
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Тёмная' }).checked).toBe(true);
  });
});
