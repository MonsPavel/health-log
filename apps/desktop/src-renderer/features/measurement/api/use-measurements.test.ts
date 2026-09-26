/**
 * TASK-033 §5/§11/§12/§19: тест api-хука списка — useInfiniteQuery поверх канала
 * `measurements/list` (TASK-030): ключ ['measurements', profileId, {limit:200}],
 * первая страница offset=0, «Показать ещё» → offset=200 (количество загруженного),
 * следующей страницы нет, когда загружено >= total. Отказ конверта → IpcApiError.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto, MeasurementListResponse } from '@hl/contracts';

import { IpcApiError } from './use-add-measurement';
import { HISTORY_PAGE_LIMIT, PROFILE_ID, measurementsKey, useMeasurements } from './use-measurements';

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

const OK_ENVELOPE = (response: MeasurementListResponse) => ({ v: 1, ok: true, data: response });

let invoke: ReturnType<typeof vi.fn>;

function renderMeasurements(): ReturnType<typeof renderHook<unknown, ReturnType<typeof useMeasurements>>> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useMeasurements(PROFILE_ID), {
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  });
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK_ENVELOPE({ items: [], total: 0 }));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('useMeasurements — чтение страницы (§5/§11)', () => {
  it('первый запрос: measurements/list, {profileId, limit:200, offset:0}', async () => {
    const { result } = renderMeasurements();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('measurements/list', {
      profileId: PROFILE_ID,
      limit: HISTORY_PAGE_LIMIT,
      offset: 0,
    });
  });

  it('ключ запроса: [measurements, profileId, {limit:200}] (§12 — префикс для инвалидаций)', () => {
    expect(measurementsKey(PROFILE_ID)).toEqual(['measurements', PROFILE_ID, { limit: 200 }]);
  });

  it('успешный конверт разворачивается: данные страницы доступны', async () => {
    invoke.mockResolvedValue(OK_ENVELOPE({ items: [dto('m-1')], total: 1 }));
    const { result } = renderMeasurements();

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.pages[0]?.items.map((m) => m.id)).toEqual(['m-1']);
    expect(result.current.data?.pages[0]?.total).toBe(1);
  });

  it('ok:false конверт → IpcApiError с dto (прецедент add/delete, §11)', async () => {
    invoke.mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: 'APP/INTERNAL', messageKey: 'errors.internal' },
    });
    const { result } = renderMeasurements();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(IpcApiError);
    expect((result.current.error as IpcApiError).dto.messageKey).toBe('errors.internal');
  });
});

describe('useMeasurements — offset-пагинация «Показать ещё» (§5/§10)', () => {
  it('есть следующая страница, пока загружено < total; fetchNextPage → offset=200', async () => {
    const firstPage = Array.from({ length: HISTORY_PAGE_LIMIT }, (_, i) => dto(`m-${i}`));
    invoke
      .mockResolvedValueOnce(OK_ENVELOPE({ items: firstPage, total: HISTORY_PAGE_LIMIT + 1 }))
      .mockResolvedValueOnce(OK_ENVELOPE({ items: [dto('m-last')], total: HISTORY_PAGE_LIMIT + 1 }));
    const { result } = renderMeasurements();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(invoke).toHaveBeenLastCalledWith('measurements/list', {
      profileId: PROFILE_ID,
      limit: HISTORY_PAGE_LIMIT,
      offset: HISTORY_PAGE_LIMIT,
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.data?.pages[1]?.items.map((m) => m.id)).toEqual(['m-last']);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('загружено >= total → следующей страницы нет (кнопке «Показать ещё» нечего грузить)', async () => {
    invoke.mockResolvedValue(OK_ENVELOPE({ items: [dto('m-1')], total: 1 }));
    const { result } = renderMeasurements();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });
});
