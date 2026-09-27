/**
 * TASK-033 §4/§24: тест проводки маршрута /journal — вкладка журнала рендерит
 * экран истории (HistoryScreen, TASK-033) под провайдерами: данные списка →
 * кнопка «Добавить» открывает форму измерения (TASK-031) на той же вкладке.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { JournalPage } from './JournalPage';

const LIST_OK = (items: MeasurementDto[]) => ({
  v: 1,
  ok: true,
  data: { items, total: items.length },
});

const MEASUREMENT: MeasurementDto = {
  id: 'm-1',
  profileId: PROFILE_ID,
  sys: 125,
  dia: 82,
  irregularPulse: false,
  arm: 'left',
  takenAtUtcMs: Date.now(),
  tzOffsetMin: -new Date().getTimezoneOffset(),
  source: 'manual',
  createdAtUtcMs: Date.now(),
  updatedAtUtcMs: Date.now(),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('JournalPage — вкладка журнала (§4 TASK-033)', () => {
  it('рендерит экран истории; «Добавить» открывает форму измерения', async () => {
    const invoke = vi.fn().mockResolvedValue(LIST_OK([MEASUREMENT]));
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // TASK-044: HistoryScreen читает фильтры через useSearchParams — нужен Router.
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: ['/journal'] },
          createElement(ToastProvider, null, createElement(JournalPage)),
        ),
      ),
    );

    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Добавить' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    expect(screen.getByTestId('input-sys')).toBeDefined();
    expect(screen.getByTestId('input-dia')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDefined();
  });
});
