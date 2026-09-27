/**
 * TASK-049 §5/§19: UI-тест секции «Продвинутые» (формат даты — перенос из «Вида»
 * TASK-047, единственный существующий advanced-параметр; будущие — §5):
 *  - заголовок секции и подпись формата даты (§17);
 *  - select отражает prefs; смена → prefs/set {patch:{dateFormat}}, пример
 *    перерисовывается под пресет (§13: prefs-пресет расширяет утилиту TASK-013).
 * Само скрытие секции при advancedMode=false — в SettingsScreen.test.ts (AC-1..3).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { AdvancedSection } from './AdvancedSection';

let invoke: ReturnType<typeof vi.fn>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const PREFS = (over: Record<string, unknown> = {}) => ({
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: true,
  netConsents: { updatesCheck: false },
  ...over,
});

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(AdvancedSection)),
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
});

describe('AdvancedSection — секция «Продвинутые» (§5/§17)', () => {
  it('заголовок секции и формат даты отражают prefs (перенос из «Вида» TASK-047)', async () => {
    invoke.mockResolvedValue(OK(PREFS({ dateFormat: 'mdy' })));
    renderSection();

    expect(screen.getByRole('heading', { name: 'Продвинутые' })).toBeDefined();
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Формат даты').value).toBe('mdy'),
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
});
