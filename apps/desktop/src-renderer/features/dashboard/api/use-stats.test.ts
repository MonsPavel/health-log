/**
 * TASK-059 §5/§11/§12/§19: тест api-хука статистики периода — useQuery поверх
 * канала `stats/period` (TASK-054). Хук вынесен сюда из 061-плана: резюме тренда
 * и aria-резюме графика потребляют ТЕ ЖЕ числа, что увидит дашборд 061 —
 * переиспользование данных, не дублирование вычислений (§5/§13).
 *
 * Конвенции — прецедент use-trend.test.ts (TASK-057): ключ ['stats', profileId,
 * period] (период в третьем элементе; префикс ['stats'] — точка инвалидаций по
 * событию measurement:changed); keepPreviousData — смена периода держит прежний
 * ответ до прихода нового; отказ конверта → IpcApiError (отказ чтения — данные,
 * не технический краш); staleTime 0 — перечитывание на каждом монтировании (та же
 * e2e-находка 057: экран не место ввода, подписка на событие живёт при экране).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { StatsResponse } from '@hl/contracts';

import { createQueryClient } from '../../../lib/query-client';
import { IpcApiError, PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { STATS_KEY_ROOT, statsKey, useStats } from './use-stats';

const STATS_RESPONSE: StatsResponse = {
  stats: {
    count: 90,
    sys: { avg: 128, min: 112, max: 145 },
    dia: { avg: 82, min: 76, max: 90 },
    critical: { high: false, low: false },
    daysWithMeasurements: 30,
    longestStreakDays: 30,
    insufficientData: { tooFewMeasurements: false, tooFewDays: false },
  },
  scale: { code: 'esc-esh-2018', version: '1.0.0', sourceLabel: 'ESC/ESH 2018' },
};

const OK_ENVELOPE = (response: StatsResponse) => ({ v: 1, ok: true, data: response });

/** Мост-мок: сигнатура с Promise-ответом — прецедент use-trend.test.ts. */
let invoke: Mock<(channel: string, payload: unknown) => Promise<unknown>>;

function renderStats(period: Parameters<typeof useStats>[1]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { hook: renderHook(() => useStats(PROFILE_ID, period), { wrapper }), queryClient };
}

beforeEach(() => {
  invoke = vi.fn((channel: string, payload: unknown) => {
    void channel;
    void payload;
    return Promise.resolve(OK_ENVELOPE(STATS_RESPONSE));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('useStats — чтение статистики периода (§11/§12)', () => {
  it('первый запрос: stats/period, {profileId, period}; ответ {stats, scale} в data', async () => {
    const { hook } = renderStats('30d');

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '30d' });
    expect(hook.result.current.data).toEqual(STATS_RESPONSE);
  });

  it('повторный монтаж экрана → refetch (запись добавлена на другом экране, §10; продовый клиент)', async () => {
    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const first = renderHook(() => useStats(PROFILE_ID, '30d'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useStats(PROFILE_ID, '30d'), { wrapper });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(second.result.current.isSuccess).toBe(true);
    second.unmount();
  });

  it('ключ запроса: [stats, profileId, period] (§12); период custom — границы в ключе', () => {
    expect(statsKey(PROFILE_ID, 'all')).toEqual(['stats', PROFILE_ID, 'all']);
    expect(statsKey(PROFILE_ID, { fromUtcMs: 1, toUtcMs: 2 })).toEqual([
      'stats',
      PROFILE_ID,
      { fromUtcMs: 1, toUtcMs: 2 },
    ]);
    // Корень инвалидаций — префикс [stats, profileId] матчит все периоды.
    expect(STATS_KEY_ROOT).toEqual(['stats']);
  });

  it('отказ конверта → IpcApiError c dto отказа (§11)', async () => {
    const dto = { code: 'STORAGE/IO', messageKey: 'errors.storage.io', params: {} };
    invoke.mockResolvedValue({ v: 1, ok: false, error: dto });
    const { hook } = renderStats('7d');

    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.error).toBeInstanceOf(IpcApiError);
    expect((hook.result.current.error as IpcApiError).dto).toEqual(dto);
  });

  it('keepPreviousData: смена периода держит предыдущие данные до прихода новых (§15)', async () => {
    const emptyResponse: StatsResponse = {
      stats: {
        count: 0,
        sys: {},
        dia: {},
        critical: { high: false, low: false },
        daysWithMeasurements: 0,
        longestStreakDays: 0,
        insufficientData: { tooFewMeasurements: true, tooFewDays: true },
      },
      scale: STATS_RESPONSE.scale,
    };
    invoke.mockImplementation((_channel: string, payload: unknown) => {
      const period = (payload as { period: string }).period;
      return Promise.resolve(OK_ENVELOPE(period === '30d' ? STATS_RESPONSE : emptyResponse));
    });

    let period: Parameters<typeof useStats>[1] = '30d';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(() => useStats(PROFILE_ID, period), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
    await waitFor(() => expect(result.current.data).toEqual(STATS_RESPONSE));

    period = '90d';
    rerender();
    expect(result.current.data).toEqual(STATS_RESPONSE);
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(emptyResponse));
  });
});
