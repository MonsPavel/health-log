/**
 * TASK-057 §5/§11/§19: тест api-хука активной шкалы — useQuery поверх канала
 * `scales/active` (TASK-051): ключ ['scales', 'active'] — канал маленький и
 * статический между запусками (§11 051), staleTime Infinity (дефолт клиента,
 * инвалидация не нужна в MVP); отказ конверта → IpcApiError.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActiveScale } from '@hl/contracts';

import { IpcApiError } from '../../measurement/api/use-add-measurement';
import { ACTIVE_SCALE_KEY, useActiveScale } from './use-active-scale';

const SCALE: ActiveScale = {
  code: 'esc-esh-2018',
  version: '1.0.0',
  sourceLabel: 'ESC/ESH 2018',
  categories: [
    {
      code: 'high_normal',
      label: 'Высокое нормальное',
      sysRange: { min: 130, max: 139 },
      diaRange: { min: 85, max: 89 },
    },
    {
      code: 'hypertension1',
      label: 'АГ 1 степени',
      sysRange: { min: 140, max: 159 },
      diaRange: { min: 90, max: 99 },
    },
  ],
  homeBPNote: '…',
  specialGroupsNote: '…',
};

let invoke: ReturnType<typeof vi.fn>;

function renderScale() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useActiveScale(), { wrapper });
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: SCALE });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('useActiveScale — чтение шкалы (§11: scales/active {})', () => {
  it('первый запрос: scales/active, payload {}; ответ в data', async () => {
    const { result } = renderScale();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('scales/active', {});
    expect(result.current.data).toEqual(SCALE);
  });

  it('ключ: [scales, active] — один канал на окно', () => {
    expect(ACTIVE_SCALE_KEY).toEqual(['scales', 'active']);
  });

  it('staleTime Infinity: данные никогда не «протухают» (§11 051 — статический между запусками)', async () => {
    const { result } = renderScale();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isStale).toBe(false);
  });

  it('отказ конверта → IpcApiError c dto отказа (§11: STORAGE/CORRUPT повреждённой шкалы)', async () => {
    const dto = { code: 'STORAGE/CORRUPT', messageKey: 'errors.storage.corrupt', params: {} };
    invoke.mockResolvedValue({ v: 1, ok: false, error: dto });
    const { result } = renderScale();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(IpcApiError);
    expect((result.current.error as IpcApiError).dto).toEqual(dto);
  });
});
