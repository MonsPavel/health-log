/**
 * TASK-057 §5/§11/§12/§19: тест api-хука серий графика — useQuery поверх канала
 * `trend/series` (TASK-056): ключ ['trend', profileId, period] — период в третьем
 * элементе (разные периоды не конфликтуют в кэше; префикс ['trend'] — точка
 * инвалидаций по событию measurement:changed, §10 «данные свежие после ввода»);
 * keepPreviousData — смена периода показывает предыдущую серию до прихода новой
 * (§15, прецедент списка истории TASK-044); отказ конверта → IpcApiError
 * (отказ чтения — данные, не технический краш, прецедент use-measurements).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrendResponse } from '@hl/contracts';

import { IpcApiError, PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { TREND_KEY_ROOT, trendKey, useTrend } from './use-trend';

const RAW_RESPONSE: TrendResponse = {
  mode: 'raw',
  points: [
    { utcMs: 0, tzOffsetMin: 180, sys: 120, dia: 80, part: 'morning', id: 'rec-1' },
    { utcMs: 43_200_000, tzOffsetMin: 180, sys: 130, dia: 85, part: 'evening', id: 'rec-2' },
  ],
};

const OK_ENVELOPE = (response: TrendResponse) => ({ v: 1, ok: true, data: response });

let invoke: ReturnType<typeof vi.fn>;

function renderTrend(period: Parameters<typeof useTrend>[1]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { hook: renderHook(() => useTrend(PROFILE_ID, period), { wrapper }), queryClient };
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK_ENVELOPE(RAW_RESPONSE));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('useTrend — чтение серий (§11/§12)', () => {
  it('первый запрос: trend/series, {profileId, period}; ответ в data', async () => {
    const { hook } = renderTrend('30d');

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '30d' });
    expect(hook.result.current.data).toEqual(RAW_RESPONSE);
  });

  it('ключ запроса: [trend, profileId, period] (§12); период custom — границы в ключе', () => {
    expect(trendKey(PROFILE_ID, 'all')).toEqual(['trend', PROFILE_ID, 'all']);
    expect(trendKey(PROFILE_ID, { fromUtcMs: 1, toUtcMs: 2 })).toEqual([
      'trend',
      PROFILE_ID,
      { fromUtcMs: 1, toUtcMs: 2 },
    ]);
    // Корень инвалидаций — префикс [trend, profileId] матчит все периоды.
    expect(TREND_KEY_ROOT).toEqual(['trend']);
  });

  it('отказ конверта → IpcApiError c dto отказа (§11)', async () => {
    const dto = { code: 'STORAGE/IO', messageKey: 'errors.storage.io', params: {} };
    invoke.mockResolvedValue({ v: 1, ok: false, error: dto });
    const { hook } = renderTrend('7d');

    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.error).toBeInstanceOf(IpcApiError);
    expect((hook.result.current.error as IpcApiError).dto).toEqual(dto);
  });

  it('keepPreviousData: смена периода держит предыдущие данные до прихода новых (§15)', async () => {
    const dailyResponse: TrendResponse = { mode: 'daily', days: [] };
    invoke.mockImplementation((_channel: string, payload: { period: string }) =>
      Promise.resolve(OK_ENVELOPE(payload.period === '30d' ? RAW_RESPONSE : dailyResponse)),
    );

    let period: Parameters<typeof useTrend>[1] = '30d';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(() => useTrend(PROFILE_ID, period), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
    await waitFor(() => expect(result.current.data).toEqual(RAW_RESPONSE));

    // Смена периода в том же наблюдателе: старая серия остаётся видимой (placeholder).
    period = '90d';
    rerender();
    expect(result.current.data).toEqual(RAW_RESPONSE);
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(dailyResponse));
  });
});
