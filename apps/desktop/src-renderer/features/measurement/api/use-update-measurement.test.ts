/**
 * TASK-038 §11/§19: тест api-слоя правки. assembleUpdateRequest — сборка payload
 * update ПОВЕРХ assembleAddRequest (§4 арх. 06: форма — единственный редактор
 * записи, одна точка валидации; схема update = {id, …поля add}, TASK-028).
 * useUpdateMeasurement — useMutation поверх call('measurements/update'): unwrap
 * конверта, onSuccess → инвалидация ['measurements'] (§12), onError → dto.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MeasurementUpdateResponse } from '@hl/contracts';

import { IpcApiError } from './use-add-measurement';
import { assembleUpdateRequest, useUpdateMeasurement } from './use-update-measurement';

const VALID_DRAFT = {
  sys: '127',
  dia: '82',
  pulse: '',
  irregular: false,
  arm: 'right' as const,
  note: 'исправлено',
  when: { date: '2026-09-24', time: '21:30' } as const,
};

const NOW_MS = Date.UTC(2026, 8, 25, 18, 0, 0);

const UPDATE_RESPONSE: MeasurementUpdateResponse = {
  measurement: {
    id: 'm-1',
    profileId: 'seed-profile-0001',
    sys: 127,
    dia: 82,
    irregularPulse: false,
    arm: 'right',
    takenAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    tzOffsetMin: 180,
    source: 'manual',
    createdAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    updatedAtUtcMs: NOW_MS,
  },
};

describe('assembleUpdateRequest — сборка payload update (§11: {id, …поля add})', () => {
  it('валидный черновик → request c id записи и полями add (числа int, takenAt стены)', () => {
    const result = assembleUpdateRequest(VALID_DRAFT, 'm-1', NOW_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.id).toBe('m-1');
    // TASK-043 (находка e2e): контракт update — strict {id, …поля} БЕЗ profileId;
    // лишний ключ каркас IPC отклоняет как VALIDATION/FAILED до хендлера (§13).
    expect('profileId' in result.request).toBe(false);
    expect(result.request.sys).toBe(127);
    expect(result.request.dia).toBe(82);
    expect(result.request.irregularPulse).toBe(false);
    expect(result.request.arm).toBe('right');
    expect(result.request.note).toBe('исправлено');
    // Настенные компоненты when сохранены в takenAt (offset устройства, §13).
    const wall = new Date(
      result.request.takenAt.utcMs + result.request.takenAt.tzOffsetMin * 60_000,
    );
    expect([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()]).toEqual([
      2026, 9, 24,
    ]);
    expect([wall.getUTCHours(), wall.getUTCMinutes()]).toEqual([21, 30]);
  });

  it('пустой пульс/заметка → поля опущены (optional §11)', () => {
    const result = assembleUpdateRequest({ ...VALID_DRAFT, pulse: '', note: '' }, 'm-1', NOW_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('pulse' in result.request).toBe(false);
    expect('note' in result.request).toBe(false);
  });

  it('невалидный черновик (sys 49) → ok:false с ошибкой поля — БЕЗ id-обёртки (§4: одна точка валидации)', () => {
    const result = assembleUpdateRequest({ ...VALID_DRAFT, sys: '49' }, 'm-1', NOW_MS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.sys?.messageKey).toBe('errors.rangeSys');
  });

  it('будущее время → ok:false, errors.futureTime (§20 AC: тост FUTURE_TIME при правке)', () => {
    const result = assembleUpdateRequest(
      { ...VALID_DRAFT, when: { date: '2099-01-01', time: '10:00' } },
      'm-1',
      NOW_MS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.when?.messageKey).toBe('errors.futureTime');
  });
});

/** Зонд: выставляет мутацию в ref для act-проверок (прецедент use-add-measurement). */
function renderProbe(
  handlers: {
    onSuccess?: (result: MeasurementUpdateResponse) => void;
    onError?: (error: unknown) => void;
  },
  queryClient: QueryClient,
): { current: ReturnType<typeof useUpdateMeasurement> } {
  const ref: { current: ReturnType<typeof useUpdateMeasurement> | undefined } = {
    current: undefined,
  };
  function Probe(): ReactElement {
    const mutation = useUpdateMeasurement(handlers);
    ref.current = mutation;
    return createElement('div');
  }
  render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  return {
    get current() {
      if (ref.current === undefined) throw new Error('Probe не отрендерился');
      return ref.current;
    },
  };
}

const REQUEST = {
  id: 'm-1',
  sys: 127,
  dia: 82,
  irregularPulse: false,
  arm: 'right' as const,
  note: 'исправлено',
  takenAt: { utcMs: Date.UTC(2026, 8, 24, 18, 30), tzOffsetMin: 180 },
};

function mockHl(invoke: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
}

describe('useUpdateMeasurement — useMutation поверх call (§11/§12)', () => {
  it('успех: invoke канала measurements/update, onSuccess получает {measurement}', async () => {
    const invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: UPDATE_RESPONSE });
    mockHl(invoke);
    const onSuccess = vi.fn();
    const probe = renderProbe({ onSuccess }, new QueryClient());

    act(() => {
      probe.current.mutate(REQUEST);
    });
    await waitFor(() => expect(probe.current.data).toEqual(UPDATE_RESPONSE));

    expect(invoke).toHaveBeenCalledWith('measurements/update', REQUEST);
    expect(onSuccess).toHaveBeenCalledWith(UPDATE_RESPONSE);
  });

  it('успех: инвалидация запросов measurements (§12)', async () => {
    const invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: UPDATE_RESPONSE });
    mockHl(invoke);
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const probe = renderProbe({}, queryClient);

    act(() => {
      probe.current.mutate(REQUEST);
    });
    await waitFor(() => expect(spy).toHaveBeenCalled());

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['measurements'] }));
  });

  it('отказ NOT_FOUND (запись уже удалена, §13) → onError получает AppErrorDto', async () => {
    const dto = {
      code: 'MEASUREMENT/NOT_FOUND',
      messageKey: 'errors.MEASUREMENT_NOT_FOUND',
    } as const;
    const invoke = vi.fn().mockResolvedValue({ v: 1, ok: false, error: dto });
    mockHl(invoke);
    const onError = vi.fn();
    const probe = renderProbe({ onError }, new QueryClient());

    act(() => {
      probe.current.mutate(REQUEST);
    });
    await waitFor(() => expect(onError).toHaveBeenCalled());

    expect(onError).toHaveBeenCalledWith(dto);
    expect(probe.current.error).toBeInstanceOf(IpcApiError);
  });

  it('транспортный сбой call (плохой конверт) → onError получает APP/INTERNAL', async () => {
    const invoke = vi.fn().mockResolvedValue({ v: 2, ok: true, data: UPDATE_RESPONSE });
    mockHl(invoke);
    const onError = vi.fn();
    const probe = renderProbe({ onError }, new QueryClient());

    act(() => {
      probe.current.mutate(REQUEST);
    });
    await waitFor(() => expect(onError).toHaveBeenCalled());

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'APP/INTERNAL', messageKey: 'errors.internal' }),
    );
  });
});
