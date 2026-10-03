/**
 * TASK-113 §19/§20: тесты секции «Помощь» экрана настроек — точка интеграции
 * руководства пользователя (§4): кнопка «Открыть руководство» вызывает канал
 * `app/open-docs` со страницей-оглавлением 'index' (§5: «index.md — оглавление +
 * линк из настроек»). Отказ конверта — role="alert" текстом каталога (§10,
 * прецедент DiagSection); успех/отказ канала — огневой-и-забыли: UI не блокируется.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { createQueryClient } from '../../../lib/query-client';
import { HelpSection } from './HelpSection';

const OK = (data: unknown) => ({ v: 1, ok: true, data });
const FAIL = (code: string) => ({
  v: 1,
  ok: false,
  error: { code, messageKey: `errors.${code}`, params: {} },
});

function renderSection(): void {
  render(
    createElement(QueryClientProvider, { client: createQueryClient() }, createElement(HelpSection)),
  );
}

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK(null));
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

describe('HelpSection — «Помощь» открывает руководство (TASK-113 §5/§6)', () => {
  it('секция с заголовком «Помощь» и кнопкой «Открыть руководство»', () => {
    renderSection();

    expect(screen.getByRole('heading', { name: 'Помощь' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Открыть руководство' })).toBeDefined();
  });

  it('клик → app/open-docs {page:"index"} — оглавление (§5)', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть руководство' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app/open-docs', { page: 'index' }));
  });

  it('отказ конверта — alert-текст каталога, кнопка снова активна (§10)', async () => {
    invoke.mockResolvedValue(FAIL('APP/INTERNAL'));
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Открыть руководство' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Открыть руководство' }).hasAttribute('disabled')).toBe(false),
    );
  });

  it('секция доступна и в простом режиме (новичку она нужнее всего, §13)', () => {
    // HelpSection рендерится SettingsScreen БЕЗ advanced-гейта — сам компонент
    // флагов не читает: простая проверка монтирования без prefs.
    renderSection();
    expect(screen.getByTestId('help-section')).toBeDefined();
  });
});
