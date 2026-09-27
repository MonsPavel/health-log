/**
 * TASK-046 §5/§10/§12/§16/§19/§20: интеграционные тесты произвольного периода
 * в панели фильтров и хуке useMeasurementFilters.
 *
 * URL — источник истины (§12): клик «Произвольный» → ?period=custom (поля
 * пусты, §10 пустые оба → границы 30d); ввод дат → URL period=custom&from=&to=
 * и query-границы parseRange (настоятельные дни, §13); перезагрузка с
 * custom-URL восстанавливает поля и границы (AC5); invalid-ввод (from > to)
 * БЛОКИРУЕТ применение — URL и запрос не меняются, текст ошибки виден (AC2);
 * сброс/уход на пресет убирает from/to из адреса.
 *
 * Ожидаемые границы — через tzOffsetMinOf(NOW_MS) (toQuery берёт зону момента
 * now; прецедент use-add-measurement.test).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

import '../../../i18n';
import { DAY_MS, type MeasurementQueryFragment } from '../model/filters';
import { MS_PER_MINUTE, tzOffsetMinOf } from '../model/taken-at';
import { HistoryFilters, useMeasurementFilters } from './HistoryFilters';

/** Фиксированное «сейчас» (§13: границы — от момента применения). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

/** Смещение зоны устройства для NOW (toQuery custom считает в зоне now). */
const OFFSET_MIN = tzOffsetMinOf(NOW_MS);

/** Настенная полночь 'YYYY-MM-DD' в зоне OFFSET → ожидаемый fromUtcMs. */
function wallStart(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1) - OFFSET_MIN * MS_PER_MINUTE;
}

/** 23:59:59.999 настенной даты в зоне OFFSET → ожидаемый toUtcMs (§13). */
function wallEnd(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1) + DAY_MS - 1 - OFFSET_MIN * MS_PER_MINUTE;
}

/** Проба адреса: MemoryRouter не пишет window.location — читаем useLocation внутри. */
interface LocationProbe {
  search: string;
}

function LocationProbeTarget({ probe }: { readonly probe: LocationProbe }): null {
  const { search } = useLocation();
  probe.search = search;
  return null;
}

/**
 * Панель, подключённая к хуку (URL настоящий — MemoryRouter): проба адреса и
 * query-фрагмента наружу — так проверяется связка «ввод → URL → запрос» (§12).
 */
function renderConnectedPanel(initialEntry: string): {
  probe: LocationProbe;
  queryProbe: { current: MeasurementQueryFragment | null };
} {
  const queryClient = new QueryClient();
  const probe: LocationProbe = { search: '' };
  const queryProbe: { current: MeasurementQueryFragment | null } = { current: null };

  function Connected(): JSX.Element {
    const filters = useMeasurementFilters();
    queryProbe.current = filters.query;
    return createElement(HistoryFilters, {
      state: filters.state,
      onPeriod: filters.setPeriod,
      onArm: filters.setArm,
      onNoted: filters.setNoted,
      onQuery: filters.setQuery,
      onRange: filters.setRange,
      onReset: filters.reset,
    });
  }

  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        children,
        createElement(LocationProbeTarget, { probe }),
      ),
    );

  render(createElement(Connected), { wrapper });
  return { probe, queryProbe };
}

/** Ввод даты в поле диапазона (controlled input — fireEvent.change). */
function typeDate(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId<HTMLInputElement>(testId), { target: { value } });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('панель — поля custom (§5/§16/§19: URL→поля)', () => {
  it('при state.period≠custom полей диапазона нет', () => {
    render(
      createElement(HistoryFilters, {
        state: { period: '30d' },
        onPeriod: () => undefined,
        onArm: () => undefined,
        onNoted: () => undefined,
        onQuery: () => undefined,
        onRange: () => undefined,
        onReset: () => undefined,
      }),
    );

    expect(screen.queryByTestId('filter-range-from')).toBeNull();
    expect(screen.queryByTestId('filter-range-to')).toBeNull();
  });

  it('при state.period=custom поля видимы и восстановлены из состояния (AC5)', () => {
    render(
      createElement(HistoryFilters, {
        state: { period: 'custom', from: '2026-03-01', to: '2026-03-15' },
        onPeriod: () => undefined,
        onArm: () => undefined,
        onNoted: () => undefined,
        onQuery: () => undefined,
        onRange: () => undefined,
        onReset: () => undefined,
      }),
    );

    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('2026-03-01');
    expect(screen.getByTestId<HTMLInputElement>('filter-range-to').value).toBe('2026-03-15');
  });
});

describe('хук + панель — клик custom и ввод дат → URL и query (§10/§12/§19)', () => {
  it('клик «Произвольный»: URL ?period=custom, поля пусты, query = границы 30d (§10)', async () => {
    const { probe, queryProbe } = renderConnectedPanel('/journal');

    fireEvent.click(screen.getByTestId('filter-period-custom'));

    await waitFor(() => expect(probe.search).toBe('?period=custom'));
    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('');
    expect(queryProbe.current).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
  });

  it('ввод обеих дат: URL period=custom&from=&to=, query — настенные границы (§13)', async () => {
    const { probe, queryProbe } = renderConnectedPanel('/journal');

    fireEvent.click(screen.getByTestId('filter-period-custom'));
    await waitFor(() => expect(screen.getByTestId('filter-range-from')).toBeDefined());

    typeDate('filter-range-from', '2026-03-01');
    await waitFor(() => expect(probe.search).toBe('?period=custom&from=2026-03-01'));

    typeDate('filter-range-to', '2026-03-15');
    await waitFor(() => expect(probe.search).toBe('?period=custom&from=2026-03-01&to=2026-03-15'));
    expect(queryProbe.current).toStrictEqual({
      fromUtcMs: wallStart('2026-03-01'),
      toUtcMs: wallEnd('2026-03-15'),
    });
  });

  it('перезагрузка с custom-URL: поля и границы восстановлены и применены (AC5)', () => {
    const { queryProbe } = renderConnectedPanel(
      '/journal?period=custom&from=2026-03-01&to=2026-03-15',
    );

    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('2026-03-01');
    expect(screen.getByTestId<HTMLInputElement>('filter-range-to').value).toBe('2026-03-15');
    expect(queryProbe.current).toStrictEqual({
      fromUtcMs: wallStart('2026-03-01'),
      toUtcMs: wallEnd('2026-03-15'),
    });
  });
});

describe('invalid-состояние блокирует применение (§19/§20 AC2)', () => {
  it('ввод from > to: URL и query не меняются, ошибка видна; исправление применяет', async () => {
    const { probe, queryProbe } = renderConnectedPanel('/journal?period=custom');

    typeDate('filter-range-from', '2026-03-15');
    await waitFor(() => expect(probe.search).toBe('?period=custom&from=2026-03-15'));

    typeDate('filter-range-to', '2026-03-01');
    // Блок: URL остался на последнем валидном применении, границы — «от даты до ∞».
    expect(probe.search).toBe('?period=custom&from=2026-03-15');
    expect(queryProbe.current).toStrictEqual({ fromUtcMs: wallStart('2026-03-15') });
    expect(screen.getByTestId('filter-range-error')).toBeDefined();

    typeDate('filter-range-to', '2026-03-20');
    await waitFor(() => expect(probe.search).toBe('?period=custom&from=2026-03-15&to=2026-03-20'));
    expect(screen.queryByTestId('filter-range-error')).toBeNull();
  });

  it('to в будущем: URL не переписан, ошибка futureTo (AC3, EC-20)', () => {
    const { probe, queryProbe } = renderConnectedPanel('/journal?period=custom');

    typeDate('filter-range-to', '2026-12-31');

    expect(probe.search).toBe('?period=custom');
    expect(queryProbe.current).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
    expect(screen.getByTestId('filter-range-error').textContent).toBe(
      '«По» не может быть в будущем',
    );
  });
});

describe('хук — setRange/setPeriod/reset с custom (§5/§12)', () => {
  /** renderHook-обёртка хука с настоящим URL (прецедент HistoryFilters.test). */
  function hookOf(initialEntry: string) {
    const queryClient = new QueryClient();
    const probe: LocationProbe = { search: '' };
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: [initialEntry] },
          children,
          createElement(LocationProbeTarget, { probe }),
        ),
      );
    return { ...renderHook(() => useMeasurementFilters(), { wrapper }), probe };
  }

  it('setRange с одной датой — прогрессивно «от даты до ∞» (§10)', async () => {
    const { result, probe } = hookOf('/journal?period=custom');

    result.current.setRange('2026-03-01', undefined);

    await waitFor(() => expect(probe.search).toBe('?period=custom&from=2026-03-01'));
    expect(result.current.query).toStrictEqual({ fromUtcMs: wallStart('2026-03-01') });
  });

  it('setRange(undefined, undefined) — даты убраны, режим custom сохранён (§10: 30d)', async () => {
    const { result, probe } = hookOf('/journal?period=custom&from=2026-03-01&to=2026-03-15');

    result.current.setRange(undefined, undefined);

    await waitFor(() => expect(probe.search).toBe('?period=custom'));
    expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
  });

  it('уход на пресет убирает from/to из URL (параметры только custom)', async () => {
    const { result, probe } = hookOf('/journal?period=custom&from=2026-03-01&to=2026-03-15');

    result.current.setPeriod('30d');

    await waitFor(() => expect(probe.search).toBe('?period=30d'));
    expect(result.current.state).toStrictEqual({ period: '30d' });
  });

  it('возврат на custom после пресета — режим без дат (URL — источник истины, §12)', async () => {
    const { result, probe } = hookOf('/journal?period=custom&from=2026-03-01&to=2026-03-15');

    result.current.setPeriod('7d');
    await waitFor(() => expect(probe.search).toBe('?period=7d'));

    result.current.setPeriod('custom');
    await waitFor(() => expect(probe.search).toBe('?period=custom'));
    expect(result.current.state).toStrictEqual({ period: 'custom' });
    expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
  });

  it('reset из custom → дефолт ?period=30d без дат (§5)', async () => {
    const { result, probe } = hookOf('/journal?period=custom&from=2026-03-01&to=2026-03-15');

    result.current.reset();

    await waitFor(() => expect(probe.search).toBe('?period=30d'));
    expect(result.current.isActive).toBe(false);
  });
});
