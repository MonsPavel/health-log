/**
 * TASK-045 §11/§12/§19: тест api-хука поиска заметок — useQuery поверх канала
 * `notes/search`: debounce 300 мс (§10), ключ ['measurements','search',query] (§12),
 * лимит страницы 50 (§13), включение только при непустом (после debounce) запросе,
 * отказ конверт → IpcApiError (прецедент use-measurements.test.ts).
 *
 * Таймеры: тесты тайминга debounce — fake timers (промотка vi.advanceTimersByTime);
 * тесты доставки ответа — real timers + waitFor (цепочка промисов TanStack под
 * фейк-таймерами не доливается однозначно; прецедент use-measurements.test.ts —
 * реальные таймеры).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto, NotesSearchResponse } from '@hl/contracts';

import { IpcApiError, PROFILE_ID } from './use-add-measurement';
import {
  notesSearchKey,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PAGE_LIMIT,
  useNotesSearch,
} from './use-notes-search';

function dto(id: string): MeasurementDto {
  return {
    id,
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
}

const OK_ENVELOPE = (response: NotesSearchResponse) => ({ v: 1, ok: true, data: response });

let invoke: ReturnType<typeof vi.fn>;

function renderSearch(initialQuery = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(({ query }: { query: string }) => useNotesSearch(query), {
    initialProps: { query: initialQuery },
    wrapper,
  });
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK_ENVELOPE({ items: [] }));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('useNotesSearch — канал и параметры (§11/§12)', () => {
  it('ключ запроса: [measurements, search, query] (§12 — корень общий с инвалидациями)', () => {
    expect(notesSearchKey('болела')).toEqual(['measurements', 'search', 'болела']);
  });

  it('пустой запрос → fetch не стартует (enabled: false)', async () => {
    const { result } = renderSearch('');

    // Больше debounce-интервала: запрос так и не уходит.
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'), { timeout: 1000 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('успешный конверт разворачивается: items доступны', async () => {
    invoke.mockResolvedValue(OK_ENVELOPE({ items: [dto('m-1')] }));
    const { result } = renderSearch('кофе');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('notes/search', {
      query: 'кофе',
      limit: SEARCH_PAGE_LIMIT,
    });
    expect(result.current.data?.items.map((m) => m.id)).toEqual(['m-1']);
  });

  it('ok:false конверт → IpcApiError с dto (прецедент list/add, §11)', async () => {
    invoke.mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: 'APP/INTERNAL', messageKey: 'errors.internal', params: undefined },
    });
    const { result } = renderSearch('кофе');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(IpcApiError);
    expect((result.current.error as IpcApiError).dto.code).toBe('APP/INTERNAL');
  });
});

describe('useNotesSearch — debounce 300 мс (§10, fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('запрос уходит не сразу, а через SEARCH_DEBOUNCE_MS', async () => {
    const { rerender } = renderSearch('');
    rerender({ query: 'болела' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50);
    });
    expect(invoke).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(invoke).toHaveBeenCalledWith('notes/search', {
      query: 'болела',
      limit: SEARCH_PAGE_LIMIT,
    });
  });

  it('быстрый ввод: промежуточные значения не уходят в канал (сброс таймера)', async () => {
    const { rerender } = renderSearch('');
    rerender({ query: 'бо' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ query: 'болела' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ query: 'болела голова' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 50);
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('notes/search', {
      query: 'болела голова',
      limit: SEARCH_PAGE_LIMIT,
    });
  });
});
