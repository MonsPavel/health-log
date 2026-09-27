/**
 * TASK-045 §5/§10/§13/§16/§17/§19: интеграция поиска в экран истории —
 * URL ?q= включает режим поиска (канал notes/search вместо list), результат —
 * тот же список строк; «Найдено N» aria-live с плюрализацией (§17); усечение
 * страницы → «показаны первые 50» (§13); пустой результат → search.empty (§10);
 * ввод в поисковую строку после debounce обновляет URL и уходит в канал;
 * live-инвалидация кэша поиска по событию measurement:changed (§12).
 * Real timers (прецедент HistoryScreen.test.ts): waitFor переживает debounce 300 мс.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { PROFILE_ID } from '../api/use-add-measurement';
import { SEARCH_PAGE_LIMIT } from '../api/use-notes-search';
import { HistoryScreen } from './HistoryScreen';

/** Фиксированное «сейчас» теста: 2026-09-27 15:00 UTC (прецедент HistoryScreen.test). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);
const TZ_OFFSET_MIN = -new Date(NOW_MS).getTimezoneOffset();

function dto(id: string, overrides: Partial<MeasurementDto> = {}): MeasurementDto {
  return {
    id,
    profileId: PROFILE_ID,
    sys: 125,
    dia: 82,
    irregularPulse: false,
    arm: 'left',
    note: 'болела голова',
    takenAtUtcMs: NOW_MS,
    tzOffsetMin: TZ_OFFSET_MIN,
    source: 'manual',
    createdAtUtcMs: NOW_MS,
    updatedAtUtcMs: NOW_MS,
    ...overrides,
  };
}

/** Мост-мок: сигнатура с Promise-ответом — mockImplementation(mock-а) допускает async. */
let invoke: Mock<(channel: string, payload: unknown) => Promise<unknown>>;

interface LocationProbe {
  search: string;
}

function LocationProbeTarget({ probe }: { readonly probe: LocationProbe }): null {
  const { search } = useLocation();
  probe.search = search;
  return null;
}

function renderHistoryAt(initialEntry = '/journal'): LocationProbe {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const probe: LocationProbe = { search: '' };
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(ToastProvider, null, createElement(HistoryScreen)),
        createElement(LocationProbeTarget, { probe }),
      ),
    ),
  );
  return probe;
}

/** Мост: invoke по каналам + on-перехват (для live-инвалидации §12). */
function bridgeMock(handlers?: Map<string, (payload: unknown) => void>): void {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, handler: (payload: unknown) => void) => {
        handlers?.set(name, handler);
        return () => undefined;
      }),
    },
  });
}

beforeEach(() => {
  // «Сейчас» зафиксировано (заголовки дней стабильны), таймеры реальные — debounce
  // переживается waitFor (прецедент HistoryScreen.test.ts).
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: { items: [], total: 0 } });
  bridgeMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('HistoryScreen — режим поиска (TASK-045 §10/§19)', () => {
  it('?q=болела → канал notes/search вызван, list отключён; результат — тот же список строк', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'notes/search'
        ? Promise.resolve({ v: 1, ok: true, data: { items: [dto('m-1')] } })
        : Promise.resolve({ v: 1, ok: true, data: { items: [], total: 0 } }),
    );
    renderHistoryAt('/journal?q=%D0%B1%D0%BE%D0%BB%D0%B5%D0%BB%D0%B0');

    await waitFor(() => expect(screen.getAllByText('болела голова').length).toBeGreaterThan(0));

    const searchCalls = invoke.mock.calls.filter(([channel]) => channel === 'notes/search');
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.at(-1)?.[1]).toEqual({ query: 'болела', limit: SEARCH_PAGE_LIMIT });
    // Режим поиска: список-канал не вызывается (data — результат поиска, §10).
    expect(invoke.mock.calls.some(([channel]) => channel === 'measurements/list')).toBe(false);
    // Подпись пагинации журнала в режиме поиска не показывается (нет total, §11).
    expect(screen.queryByTestId('history-shown')).toBeNull();
  });

  it('«Найдено N» — aria-live строка с плюрализацией (§16/§17: 1 запись / 2 записи / 5 записей)', async () => {
    const cases: readonly { readonly items: number; readonly text: string }[] = [
      { items: 1, text: 'Найдено: 1 запись' },
      { items: 2, text: 'Найдено: 2 записи' },
      { items: 5, text: 'Найдено: 5 записей' },
    ];
    for (const { items, text } of cases) {
      cleanup();
      invoke.mockImplementation((channel: string) =>
        channel === 'notes/search'
          ? Promise.resolve({
              v: 1,
              ok: true,
              data: { items: Array.from({ length: items }, (_, i) => dto(`m-${i}`)) },
            })
          : Promise.resolve({ v: 1, ok: true, data: { items: [], total: 0 } }),
      );
      renderHistoryAt('/journal?q=%D0%B1%D0%BE%D0%BB%D0%B5%D0%BB%D0%B0');

      const found = await waitFor(() => screen.getByTestId('search-found'));
      expect(found.getAttribute('aria-live')).toBe('polite');
      expect(found.textContent).toBe(text);
    }
  });

  it('результат = лимиту страницы → предупреждение «показаны первые 50» (§13)', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'notes/search'
        ? Promise.resolve({
            v: 1,
            ok: true,
            data: {
              items: Array.from({ length: SEARCH_PAGE_LIMIT }, (_, i) => dto(`m-${i}`)),
            },
          })
        : Promise.resolve({ v: 1, ok: true, data: { items: [], total: 0 } }),
    );
    renderHistoryAt('/journal?q=%D0%B1%D0%BE%D0%BB%D0%B5%D0%BB%D0%B0');

    const truncated = await waitFor(() => screen.getByTestId('search-truncated'));
    expect(truncated.textContent).toBe('Показаны первые 50 результатов — уточните запрос');
  });

  it('пустой результат поиска → search.empty, не обучающее EmptyHistory (§10)', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'notes/search'
        ? Promise.resolve({ v: 1, ok: true, data: { items: [] } })
        : Promise.resolve({
            v: 1,
            ok: true,
            data: {
              items: [dto('m-1')],
              total: 1,
            },
          }),
    );
    renderHistoryAt('/journal?q=%D0%B1%D0%BE%D0%BB%D0%B5%D0%BB%D0%B0');

    const empty = await waitFor(() => screen.getByTestId('empty-search'));
    expect(empty.textContent).toContain('Ничего не найдено — измените запрос');
    expect(screen.queryByTestId('empty-history')).toBeNull();
  });

  it('фильтры периода сужают результат поиска на клиенте (§10: search по всей БД)', async () => {
    // Записи «болела» в разные дни: фильтр 7 дней (URL period=7d) отсекает старую.
    const day = 86_400_000;
    invoke.mockImplementation((channel: string) =>
      channel === 'notes/search'
        ? Promise.resolve({
            v: 1,
            ok: true,
            data: {
              items: [
                dto('m-fresh', { takenAtUtcMs: NOW_MS - day }),
                dto('m-stale', { takenAtUtcMs: NOW_MS - 30 * day }),
              ],
            },
          })
        : Promise.resolve({ v: 1, ok: true, data: { items: [], total: 0 } }),
    );
    renderHistoryAt('/journal?period=7d&q=%D0%B1%D0%BE%D0%BB%D0%B5%D0%BB%D0%B0');

    await waitFor(() => expect(screen.getAllByText('болела голова').length).toBeGreaterThan(0));
    // m-fresh в списке; m-stale (30 дней назад, вне 7д) — отфильтрован на клиенте.
    expect(document.querySelector('[data-row-menu="m-fresh"]')).not.toBeNull();
    expect(document.querySelector('[data-row-menu="m-stale"]')).toBeNull();
    expect(screen.getByTestId('search-found').textContent).toBe('Найдено: 1 запись');
  });

  it('ввод в строку поиска: после debounce URL получает q, канал вызывает notes/search', async () => {
    const probe = renderHistoryAt('/journal');

    // Старт в режиме списка: list вызван.
    await waitFor(() => expect(screen.getByTestId('history-filters')).toBeDefined());
    expect(invoke.mock.calls.some(([channel]) => channel === 'measurements/list')).toBe(true);

    fireEvent.change(screen.getByTestId('filter-query'), { target: { value: 'кофе' } });
    expect(probe.search).not.toContain('q='); // debounce: URL ещё не переписан

    await waitFor(() => expect(probe.search).toContain('q=%D0%BA%D0%BE%D1%84%D0%B5'));
    await waitFor(() =>
      expect(invoke.mock.calls.some(([channel]) => channel === 'notes/search')).toBe(true),
    );
  });

  it('событие measurement:changed инвалидирует кэш поиска (§12: ключ [measurements, search])', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    bridgeMock(handlers);
    renderHistoryAt('/journal?q=%D0%BA%D0%BE%D1%84%D0%B5');

    await waitFor(() => expect(screen.getByTestId('history-filters')).toBeDefined());
    const callsBefore = invoke.mock.calls.length;

    const handler = handlers.get('measurement:changed');
    expect(handler).toBeDefined();
    handler?.({ profileId: PROFILE_ID });

    // Инвалидация триггерит refetch notes/search (запросов стало больше).
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(invoke.mock.calls.some(([channel]) => channel === 'notes/search')).toBe(true);
  });
});
