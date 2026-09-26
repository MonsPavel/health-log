/**
 * TASK-031 §11/§13/§19: тест api-слоя формы. assembleAddRequest — клиентская
 * валидация ТА ЖЕ zod-схемой contracts (TASK-028, единая истина) + сборка
 * payload (числа-строки черновика → int, takenAt на момент submit, §13).
 * useAddMeasurement — useMutation поверх call('measurements/add'): unwrap
 * конверта, onSuccess → инвалидация ['measurements'] (§12), onError → dto.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MeasurementAddResponse } from '@hl/contracts';

import { assembleAddRequest, IpcApiError, useAddMeasurement } from './use-add-measurement';

const VALID_DRAFT = {
  sys: '125',
  dia: '82',
  pulse: '70',
  irregular: false,
  arm: 'left' as const,
  note: 'после прогулки',
  when: 'now' as const,
};

const NOW_MS = Date.UTC(2026, 8, 25, 18, 0, 0);

describe('assembleAddRequest — сборка payload (§11/§13)', () => {
  it('валидный черновик → request: числа int, заметка, profileId seed-профиля', () => {
    const result = assembleAddRequest(VALID_DRAFT, NOW_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.profileId).toBe('seed-profile-0001');
    expect(result.request.sys).toBe(125);
    expect(result.request.dia).toBe(82);
    expect(result.request.pulse).toBe(70);
    expect(result.request.irregularPulse).toBe(false);
    expect(result.request.arm).toBe('left');
    expect(result.request.note).toBe('после прогулки');
  });

  it('when «now» → takenAt собирается на момент submit (nowMs), offset устройства', async () => {
    const { tzOffsetMinOf } = await import('../model/taken-at');
    const result = assembleAddRequest(VALID_DRAFT, NOW_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.takenAt.utcMs).toBe(NOW_MS);
    expect(result.request.takenAt.tzOffsetMin).toBe(tzOffsetMinOf(NOW_MS));
  });

  it('when {date, time} → заднее число: стена 2026-09-24 21:30 → utcMs по offset устройства', async () => {
    const { tzOffsetMinOf } = await import('../model/taken-at');
    const result = assembleAddRequest(
      { ...VALID_DRAFT, when: { date: '2026-09-24', time: '21:30' } },
      NOW_MS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const offset = tzOffsetMinOf(NOW_MS);
    expect(result.request.takenAt.tzOffsetMin).toBe(offset);
    // Инвариант Instant: utcMs + offset·мин = настенные компоненты ввода.
    const wall = new Date(result.request.takenAt.utcMs + offset * 60_000);
    expect([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()]).toEqual([
      2026, 9, 24,
    ]);
    expect([wall.getUTCHours(), wall.getUTCMinutes()]).toEqual([21, 30]);
  });

  it('пустой пульс → поле опущено; пустая заметка → опущена (§11: optional)', () => {
    const result = assembleAddRequest({ ...VALID_DRAFT, pulse: '', note: '' }, NOW_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('pulse' in result.request).toBe(false);
    expect('note' in result.request).toBe(false);
  });

  it('будущее время (ручной ввод) → ok:false, errors.futureTime, БЕЗ request (§20: без вызова IPC)', () => {
    const result = assembleAddRequest(
      { ...VALID_DRAFT, when: { date: '2026-09-26', time: '23:59' } },
      NOW_MS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.when?.messageKey).toBe('errors.futureTime');
  });

  it('неполный ручной ввод (нет времени) → ok:false, ключ неполноты when', () => {
    const result = assembleAddRequest(
      { ...VALID_DRAFT, when: { date: '2026-09-24', time: '' } },
      NOW_MS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.when?.messageKey).toBe('measurement.errors.whenIncomplete');
  });

  it('sys=49 → подсветка sys: errors.rangeSys с params {min:50, max:300} (§20)', () => {
    const result = assembleAddRequest({ ...VALID_DRAFT, sys: '49' }, NOW_MS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.sys?.messageKey).toBe('errors.rangeSys');
    expect(result.fieldErrors.sys?.params).toEqual({ min: 50, max: 300 });
  });

  it('sys=400 → errors.rangeSys с params из схемы too_big', () => {
    const result = assembleAddRequest({ ...VALID_DRAFT, sys: '400' }, NOW_MS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.sys?.messageKey).toBe('errors.rangeSys');
    expect(result.fieldErrors.sys?.params).toEqual({ min: 50, max: 300 });
  });

  it('sys ≤ dia → errors.sysLeDia на dia (инвариант VO, TASK-016)', () => {
    const result = assembleAddRequest({ ...VALID_DRAFT, sys: '80', dia: '82' }, NOW_MS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.dia?.messageKey).toBe('errors.sysLeDia');
  });

  it('пустой sys → клиентский ключ обязательности (zod-текст не нужен)', () => {
    const result = assembleAddRequest({ ...VALID_DRAFT, sys: '' }, NOW_MS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.sys?.messageKey).toBe('measurement.errors.required');
  });

  it('заметка 501 символ → errors.noteTooLong с params {max:500} (схема §13)', () => {
    const result = assembleAddRequest({ ...VALID_DRAFT, note: 'x'.repeat(501) }, NOW_MS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.note?.messageKey).toBe('errors.noteTooLong');
    expect(result.fieldErrors.note?.params).toEqual({ max: 500 });
  });
});

/** Зонд: выставляет мутацию в ref для act-проверок (прецедент toast.test.ts). */
function renderProbe(
  handlers: {
    onSuccess?: (result: MeasurementAddResponse) => void;
    onError?: (error: unknown) => void;
  },
  queryClient: QueryClient,
): { current: ReturnType<typeof useAddMeasurement> } {
  const ref: { current: ReturnType<typeof useAddMeasurement> | undefined } = { current: undefined };
  function Probe(): ReactElement {
    const mutation = useAddMeasurement(handlers);
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
  profileId: 'seed-profile-0001',
  sys: 125,
  dia: 82,
  pulse: 70,
  irregularPulse: false,
  arm: 'left' as const,
  takenAt: { utcMs: NOW_MS, tzOffsetMin: 180 },
};

const ADD_RESPONSE: MeasurementAddResponse = {
  measurement: {
    id: 'm-1',
    profileId: 'seed-profile-0001',
    sys: 125,
    dia: 82,
    pulse: 70,
    irregularPulse: false,
    arm: 'left',
    takenAtUtcMs: NOW_MS,
    tzOffsetMin: 180,
    source: 'manual',
    createdAtUtcMs: NOW_MS,
    updatedAtUtcMs: NOW_MS,
  },
  flags: {},
};

function mockHl(invoke: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
}

describe('useAddMeasurement — useMutation поверх call (§11/§12)', () => {
  it('успех: invoke канала measurements/add, onSuccess получает {measurement, flags}', async () => {
    const invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: ADD_RESPONSE });
    mockHl(invoke);
    const onSuccess = vi.fn();
    const queryClient = new QueryClient();
    const probe = renderProbe({ onSuccess }, queryClient);

    act(() => {
      probe.current.mutate(REQUEST);
    });
    await waitFor(() => expect(probe.current.data).toEqual(ADD_RESPONSE));

    expect(invoke).toHaveBeenCalledWith('measurements/add', REQUEST);
    expect(onSuccess).toHaveBeenCalledWith(ADD_RESPONSE);
  });

  it('успех: инвалидация запросов measurements (§12)', async () => {
    const invoke = vi.fn().mockResolvedValue({ v: 1, ok: true, data: ADD_RESPONSE });
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

  it('отказ конверта ok:false → onError получает AppErrorDto (§11)', async () => {
    const dto = { code: 'VALIDATION/FAILED', messageKey: 'errors.validation' } as const;
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
    const invoke = vi.fn().mockResolvedValue({ v: 2, ok: true, data: ADD_RESPONSE });
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
