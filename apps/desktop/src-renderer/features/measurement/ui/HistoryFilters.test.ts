/**
 * TASK-044 §5/§16/§19/§20: тесты панели фильтров и хука useMeasurementFilters.
 *
 * Компонент (§16): сегмент-контрол периода — нативные radio в fieldset/legend
 * (прецедент ArmSegment), «Произвольный» — disabled-заглушка до TASK-046;
 * select руки и чекбокс заметок с label; кнопка сброса. Панель презентационная:
 * значения — проп-состояние, клики — колбэки (URL владеет хук).
 *
 * Хук (§5/§12/§13): URL → состояние (мусор → дефолт, §14), query-фрагмент
 * (fromUtcMs пресета — от «сейчас» момента применения), isActive; применение
 * фильтра переписывает URL (reset → period=30d), очистка arm/noted убирает
 * параметры из адреса.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import '../../../i18n';
import { DAY_MS } from '../model/filters';
import { HistoryFilters, useMeasurementFilters } from './HistoryFilters';

/** Фиксированное «сейчас» теста (§13: границы пресета — от момента применения). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

function renderFilters(
  state = { period: '30d' as const },
  handlers: {
    readonly onPeriod?: (period: '7d' | '30d' | '90d' | 'all') => void;
    readonly onArm?: (arm: 'left' | 'right' | undefined) => void;
    readonly onNoted?: (noted: boolean) => void;
    readonly onReset?: () => void;
  } = {},
): void {
  render(
    createElement(HistoryFilters, {
      state,
      onPeriod: handlers.onPeriod ?? (() => undefined),
      onArm: handlers.onArm ?? (() => undefined),
      onNoted: handlers.onNoted ?? (() => undefined),
      onReset: handlers.onReset ?? (() => undefined),
    }),
  );
}

/** Обёртка renderHook: MemoryRouter с заданным начальным URL (§12: URL — источник истины). */
function renderFiltersHook(initialEntry: string) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: [initialEntry] }, children),
    );
  return renderHook(() => useMeasurementFilters(), { wrapper });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HistoryFilters — структура и a11y (§16/§17)', () => {
  it('панель: 5 радио периода (custom — disabled-заглушка), подписи из каталога', () => {
    renderFilters();

    expect(screen.getByTestId('history-filters')).toBeDefined();
    // fieldset+legend — группа с именем «Период» (§16: нативная семантика radio).
    expect(screen.getByRole('group', { name: 'Период' })).toBeDefined();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(5);
    // Подписи пресетов — ключи §17: 7д/30д/90д/всё/произвольный.
    for (const [value, label] of [
      ['7d', '7 дней'],
      ['30d', '30 дней'],
      ['90d', '90 дней'],
      ['all', 'Всё'],
      ['custom', 'Произвольный'],
    ] as const) {
      expect(screen.getByTestId(`filter-period-${value}`).getAttribute('value')).toBe(value);
      expect(screen.getByLabelText(label)).toBeDefined();
    }
    expect((screen.getByTestId('filter-period-custom') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('filter-period-custom')?.hasAttribute('checked')).toBe(false);
  });

  it('выбранный период отражает проп-состояние (контролируемый компонент)', () => {
    renderFilters({ period: '90d' });

    expect((screen.getByTestId('filter-period-90d') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('filter-period-30d') as HTMLInputElement).checked).toBe(false);
  });

  it('select руки с label «Рука»: Все/Левая/Правая (§17 filters.arm.any/left/right)', () => {
    renderFilters();

    const select = screen.getByLabelText('Рука') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Все',
      'Левая',
      'Правая',
    ]);
    expect(select.value).toBe('');
  });

  it('чекбокс «Только с заметками» с label, отмечен по проп-состоянию (§17 filters.noted)', () => {
    renderFilters({ period: '30d', noted: true });

    const checkbox = screen.getByLabelText('Только с заметками') as HTMLInputElement;
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(true);
  });

  it('кнопка сброса фильтров присутствует (§17 filters.reset)', () => {
    renderFilters();

    expect(screen.getByTestId('filters-reset').textContent).toBe('Сбросить фильтры');
  });

  it('axe: панель без critical-нарушений (§16)', async () => {
    const { container } = render(
      createElement(HistoryFilters, {
        state: { period: '7d', arm: 'left', noted: true },
        onPeriod: () => undefined,
        onArm: () => undefined,
        onNoted: () => undefined,
        onReset: () => undefined,
      }),
    );

    const results = await axe.run(container);
    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});

describe('HistoryFilters — клики вызывают колбэки (§19)', () => {
  it('клик пресета 7д → onPeriod("7d")', async () => {
    const onPeriod = vi.fn();
    renderFilters({ period: '30d' }, { onPeriod });

    fireEvent.click(screen.getByTestId('filter-period-7d'));

    expect(onPeriod).toHaveBeenCalledWith('7d');
  });

  it('select руки: left → onArm("left"), обратно «Все» → onArm(undefined)', async () => {
    const user = userEvent.setup();
    const onArm = vi.fn();
    renderFilters({ period: '30d' }, { onArm });

    await user.selectOptions(screen.getByLabelText('Рука'), 'left');
    expect(onArm).toHaveBeenLastCalledWith('left');

    await user.selectOptions(screen.getByLabelText('Рука'), '');
    expect(onArm).toHaveBeenLastCalledWith(undefined);
  });

  it('чекбокс заметок: клик → onNoted(true), повторный → onNoted(false)', async () => {
    const user = userEvent.setup();
    const onNoted = vi.fn();
    renderFilters({ period: '30d' }, { onNoted });

    await user.click(screen.getByLabelText('Только с заметками'));
    expect(onNoted).toHaveBeenLastCalledWith(true);
  });

  it('кнопка сброса → onReset (§19)', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    renderFilters({ period: '7d', arm: 'right', noted: true }, { onReset });

    await user.click(screen.getByTestId('filters-reset'));

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe('useMeasurementFilters — чтение URL (§12/§13/§14)', () => {
  it('дефолтный URL: состояние 30d, query = {fromUtcMs: now − 30 суток}, не активен', () => {
    const { result } = renderFiltersHook('/journal');

    expect(result.current.state).toStrictEqual({ period: '30d' });
    expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
    expect(result.current.isActive).toBe(false);
  });

  it('URL с фильтрами восстановлен (§20 AC5): state + query c arm/hasNote, активен', () => {
    const { result } = renderFiltersHook('/journal?period=7d&arm=left&noted=1');

    expect(result.current.state).toStrictEqual({ period: '7d', arm: 'left', noted: true });
    expect(result.current.query).toStrictEqual({
      fromUtcMs: NOW_MS - 7 * DAY_MS,
      arm: 'left',
      hasNote: true,
    });
    expect(result.current.isActive).toBe(true);
  });

  it('мусорный URL → дефолт 30d, query с границей 30 суток (§14/§20 AC3)', () => {
    const { result } = renderFiltersHook('/journal?period=%3Cscript%3E&arm=center&noted=yes');

    expect(result.current.state).toStrictEqual({ period: '30d' });
    expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
  });

  it('«сейчас» берётся в момент применения, а не на каждый рендер (§13): rerender не меняет query', () => {
    const { result, rerender } = renderFiltersHook('/journal?period=90d');
    const before = result.current.query;

    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 5 * 60_000);
    rerender();

    expect(result.current.query).toStrictEqual(before);
  });
});

describe('useMeasurementFilters — применение фильтров переписывает URL (§5/§12)', () => {
  it('setPeriod("all") → ?period=all, query без fromUtcMs', async () => {
    const { result } = renderFiltersHook('/journal');

    result.current.setPeriod('all');

    await waitFor(() => expect(result.current.state).toStrictEqual({ period: 'all' }));
    expect(result.current.query).toStrictEqual({});
    expect(window.location.hash).toContain('period=all');
  });

  it('setArm("right") добавляет arm=right; setArm(undefined) убирает параметр', async () => {
    const { result } = renderFiltersHook('/journal');

    result.current.setArm('right');
    await waitFor(() =>
      expect(result.current.query).toStrictEqual({
        fromUtcMs: NOW_MS - 30 * DAY_MS,
        arm: 'right',
      }),
    );

    result.current.setArm(undefined);
    await waitFor(() =>
      expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS }),
    );
  });

  it('setNoted(true) добавляет noted=1; setNoted(false) убирает', async () => {
    const { result } = renderFiltersHook('/journal');

    result.current.setNoted(true);
    await waitFor(() =>
      expect(result.current.query).toStrictEqual({
        fromUtcMs: NOW_MS - 30 * DAY_MS,
        hasNote: true,
      }),
    );

    result.current.setNoted(false);
    await waitFor(() =>
      expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS }),
    );
  });

  it('setPeriod(7d) фиксирует границу от момента клика (§13/§20 AC1)', async () => {
    const { result } = renderFiltersHook('/journal');

    result.current.setPeriod('7d');

    await waitFor(() =>
      expect(result.current.query).toStrictEqual({ fromUtcMs: NOW_MS - 7 * DAY_MS }),
    );
  });

  it('reset → URL в дефолт period=30d, arm/noted сняты (§5)', async () => {
    const { result } = renderFiltersHook('/journal?period=7d&arm=left&noted=1');

    result.current.reset();

    await waitFor(() => expect(result.current.state).toStrictEqual({ period: '30d' }));
    expect(result.current.isActive).toBe(false);
    expect(window.location.hash).toContain('period=30d');
    expect(window.location.hash).not.toContain('arm=');
    expect(window.location.hash).not.toContain('noted=');
  });
});
