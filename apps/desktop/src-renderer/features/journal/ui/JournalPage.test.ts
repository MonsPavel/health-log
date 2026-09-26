/**
 * TASK-031 §4/§24: тест проводки маршрута /journal — вкладка ввода рендерит
 * форму измерения (TASK-031) под провайдерами; заглушка TASK-013 заменена.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { JournalPage } from './JournalPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('JournalPage — вкладка ввода (§4 TASK-031)', () => {
  it('рендерит форму измерения: поля СДА/ДДА и кнопка Сохранить', () => {
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke: vi.fn(), on: vi.fn(() => () => undefined) },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ToastProvider, null, createElement(JournalPage)),
      ),
    );

    expect(screen.getByTestId('input-sys')).toBeDefined();
    expect(screen.getByTestId('input-dia')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDefined();
  });
});
