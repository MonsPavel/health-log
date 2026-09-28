/**
 * TASK-057 §5/§12/§19/§20: тесты PeriodSwitcher — период-контрол экрана
 * «Динамика» (7д/30д/90д/всё/произвольный, переиспользование семантик
 * TASK-044/046 через lib/period и полей CustomRangeFields измерения).
 *
 * Компонент презентационный (§16, прецедент HistoryFilters): значения —
 * проп-состояние, события — колбэки. Хук useDashboardPeriod (§12): URL —
 * источник истины (`?period=`, lib/period); применение переписывает URL
 * (replace — периоды не засоряют историю навигации); periodToStatsParam —
 * период каналов trend/stats (custom — готовые utcMs-границы).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

import '../../../i18n';
import { DAY_MS } from '../../../lib/period';
import { MS_PER_MINUTE, tzOffsetMinOf } from '../../measurement/model/taken-at';
import { PeriodSwitcher, useDashboardPeriod } from './PeriodSwitcher';

/** Фиксированное «сейчас» (§13: границы — от момента применения). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

/** Смещение зоны устройства для NOW. */
const OFFSET_MIN = tzOffsetMinOf(NOW_MS);

/** Настенная полночь 'YYYY-MM-DD' в зоне OFFSET → ожидаемый fromUtcMs. */
function wallStart(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1) - OFFSET_MIN * MS_PER_MINUTE;
}

/** 23:59:59.999 настенной даты в зоне OFFSET → ожидаемый toUtcMs (§13 046). */
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

/** Панель, подключённая к хуку (URL настоящий — MemoryRouter): связка «ввод → URL → период канала». */
function renderConnectedSwitcher(initialEntry: string): {
  probe: LocationProbe;
  paramProbe: { current: unknown };
} {
  const queryClient = new QueryClient();
  const probe: LocationProbe = { search: '' };
  const paramProbe: { current: unknown } = { current: null };

  function Connected(): JSX.Element {
    const period = useDashboardPeriod();
    paramProbe.current = period.param;
    return createElement(PeriodSwitcher, {
      state: period.state,
      onPeriod: period.setPeriod,
      onRange: period.setRange,
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
  return { probe, paramProbe };
}

beforeEach(() => {
  // «Сейчас» фиксировано: момент применения (Date.now в хуке) детерминирован (§13).
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PeriodSwitcher — сегмент периода (§5: 7д/30д/90д/всё/произвольный)', () => {
  it('пять радиокнопок с подписями каталога (переиспользование ключей фильтров 044/046)', () => {
    render(
      createElement(PeriodSwitcher, {
        state: { period: '30d' },
        onPeriod: () => undefined,
        onRange: () => undefined,
      }),
    );

    expect(screen.getByRole('group', { name: 'Период' })).not.toBeNull();
    expect(screen.getByTestId('dashboard-period-7d')).not.toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('dashboard-period-30d').checked).toBe(true);
    expect(screen.getByTestId('dashboard-period-90d')).not.toBeNull();
    expect(screen.getByTestId('dashboard-period-all')).not.toBeNull();
    expect(screen.getByTestId('dashboard-period-custom')).not.toBeNull();
    expect(screen.getByText('30 дней')).not.toBeNull();
    expect(screen.getByText('Всё')).not.toBeNull();
  });

  it('клик по пресету → колбэк onPeriod с периодом (§16: сегмент-контрол на нативных radio)', () => {
    const onPeriod = vi.fn();
    render(
      createElement(PeriodSwitcher, {
        state: { period: '30d' },
        onPeriod,
        onRange: () => undefined,
      }),
    );

    fireEvent.click(screen.getByTestId('dashboard-period-7d'));
    expect(onPeriod).toHaveBeenCalledWith('7d');
  });

  it('custom: поля «С»/«По» (CustomRangeFields 046) видимы; ввод даты → onRange', () => {
    const onRange = vi.fn();
    render(
      createElement(PeriodSwitcher, {
        state: { period: 'custom', from: '2026-09-01' },
        onPeriod: () => undefined,
        onRange,
      }),
    );

    expect(screen.getByTestId('filter-range-from')).not.toBeNull();
    fireEvent.change(screen.getByTestId<HTMLInputElement>('filter-range-to'), {
      target: { value: '2026-09-10' },
    });
    expect(onRange).toHaveBeenCalledWith('2026-09-01', '2026-09-10');
  });

  it('не-custom: полей диапазона нет (§5 046: поля — только режима custom)', () => {
    render(
      createElement(PeriodSwitcher, {
        state: { period: '90d' },
        onPeriod: () => undefined,
        onRange: () => undefined,
      }),
    );

    expect(screen.queryByTestId('filter-range-from')).toBeNull();
  });
});

describe('useDashboardPeriod — URL источник истины (§12: ?period=)', () => {
  it('дефолт без параметров: state 30d, период канала «30d» (§5 044: дефолт виден в адресе)', () => {
    const { paramProbe } = renderConnectedSwitcher('/dashboard');

    expect(paramProbe.current).toBe('30d');
  });

  it('(AC4) клик пресета → URL меняется на ?period=… (replace), период канала — пресет', async () => {
    const { probe, paramProbe } = renderConnectedSwitcher('/dashboard');

    fireEvent.click(screen.getByTestId('dashboard-period-7d'));
    expect(probe.search).toBe('?period=7d');
    await vi.waitFor(() => expect(paramProbe.current).toBe('7d'));
  });

  it('(AC4) «Произвольный»: клик → ?period=custom; ввод дат → period=custom&from=&to= и utcMs-границы канала', () => {
    const { probe, paramProbe } = renderConnectedSwitcher('/dashboard');

    fireEvent.click(screen.getByTestId('dashboard-period-custom'));
    expect(probe.search).toBe('?period=custom');

    fireEvent.change(screen.getByTestId<HTMLInputElement>('filter-range-from'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByTestId<HTMLInputElement>('filter-range-to'), {
      target: { value: '2026-09-10' },
    });
    expect(probe.search).toBe('?period=custom&from=2026-09-01&to=2026-09-10');
    expect(paramProbe.current).toEqual({
      fromUtcMs: wallStart('2026-09-01'),
      toUtcMs: wallEnd('2026-09-10'),
    });
  });

  it('загрузка с custom-URL восстанавливает поля и границы (AC5 046: перезагрузка), мусор → дефолт 30d', () => {
    const custom = renderConnectedSwitcher(
      '/dashboard?period=custom&from=2026-09-01&to=2026-09-10',
    );
    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('2026-09-01');
    expect(custom.paramProbe.current).toEqual({
      fromUtcMs: wallStart('2026-09-01'),
      toUtcMs: wallEnd('2026-09-10'),
    });
    cleanup();

    const garbage = renderConnectedSwitcher('/dashboard?period=week');
    // Мусорный период молча → дефолт 30d (§14: без ошибок); URL не переписывается
    // при загрузке (применение — только действием пользователя, §12 044).
    expect(garbage.paramProbe.current).toBe('30d');
  });
});
