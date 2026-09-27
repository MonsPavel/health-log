/**
 * TASK-045 §5/§10/§16/§19: тесты строки поиска в панели фильтров — input
 * type="search" с label (§16), debounce 300 мс до применения в URL (§10),
 * Esc очищает (§16), ×-кнопка очистки, синхронизация черновика с внешним
 * состоянием (сброс фильтров очищает поле). Fake timers + fireEvent — прецедент
 * toast.test.ts (userEvent на фейк-таймерах не используется в проекте).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import type { HistoryFilterState } from '../model/filters';
import { SEARCH_DEBOUNCE_MS } from '../api/use-notes-search';
import { HistoryFilters } from './HistoryFilters';

const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

function renderFilters(
  state: HistoryFilterState = { period: '30d' },
  handlers: { readonly onQuery?: (q: string) => void } = {},
): void {
  render(
    createElement(HistoryFilters, {
      state,
      onPeriod: () => undefined,
      onArm: () => undefined,
      onNoted: () => undefined,
      onReset: () => undefined,
      onRange: () => undefined,
      onQuery: handlers.onQuery ?? (() => undefined),
    }),
  );
}

/** Ввод текста в поисковую строку (controlled input — fireEvent.change). */
function typeQuery(text: string): void {
  fireEvent.change(screen.getByTestId('filter-query'), { target: { value: text } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('строка поиска — структура и a11y (§16/§17)', () => {
  it('input type="search" с label из каталога (search.placeholder)', () => {
    renderFilters();

    const input = screen.getByTestId('filter-query');
    expect(input.getAttribute('type')).toBe('search');
    expect(screen.getByLabelText('Поиск по заметкам')).toBe(input);
  });

  it('восстанавливает значение из URL-состояния (state.q)', () => {
    renderFilters({ period: '30d', q: 'болела' });

    expect(screen.getByTestId<HTMLInputElement>('filter-query').value).toBe('болела');
  });

  it('×-кнопка появляется только при непустом черновике, aria-label из каталога', () => {
    renderFilters();

    expect(screen.queryByTestId('filter-query-clear')).toBeNull();
    typeQuery('кофе');
    expect(screen.getByTestId('filter-query-clear')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Очистить поиск' })).toBe(
      screen.getByTestId('filter-query-clear'),
    );
  });
});

describe('строка поиска — debounce применения (§10/§12)', () => {
  it('ввод не применяет URL сразу; через 300 мс — onQuery с полным значением', () => {
    const onQuery = vi.fn();
    renderFilters({ period: '30d' }, { onQuery });

    typeQuery('болела');
    expect(onQuery).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(onQuery).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith('болела');
  });

  it('продолжение ввода сбрасывает таймер: применяется только финальное значение', () => {
    const onQuery = vi.fn();
    renderFilters({ period: '30d' }, { onQuery });

    typeQuery('бол');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 100);
    });
    typeQuery('болела голова');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 100);
    });
    expect(onQuery).not.toHaveBeenCalled(); // старый таймер сброшен, новый не дошёл

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith('болела голова');
  });

  it('ввод, совпадающий с применённым состоянием, повторно onQuery не вызывает', () => {
    const onQuery = vi.fn();
    renderFilters({ period: '30d', q: 'кофе' }, { onQuery });

    typeQuery('кофе');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 1);
    });
    expect(onQuery).not.toHaveBeenCalled();
  });
});

describe('строка поиска — очистка (§10/§16)', () => {
  it('Esc очищает поле и применяет пустой запрос немедленно (§16)', () => {
    const onQuery = vi.fn();
    renderFilters({ period: '30d', q: 'болела' }, { onQuery });

    const input = screen.getByTestId<HTMLInputElement>('filter-query');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('');
    expect(onQuery).toHaveBeenCalledWith('');
    // Немедленно — до истечения debounce (таймер обновления ещё не горел).
    expect(onQuery).toHaveBeenCalledTimes(1);
  });

  it('×-кнопка очищает поле и применяет пустой запрос немедленно', () => {
    const onQuery = vi.fn();
    renderFilters({ period: '30d', q: 'болела' }, { onQuery });

    fireEvent.click(screen.getByTestId('filter-query-clear'));

    expect(screen.getByTestId<HTMLInputElement>('filter-query').value).toBe('');
    expect(onQuery).toHaveBeenCalledWith('');
  });
});

describe('строка поиска — синхронизация с внешним состоянием (§12)', () => {
  it('внешняя смена состояния (сброс фильтров) очищает черновик', () => {
    const { rerender } = render(
      createElement(HistoryFilters, {
        state: { period: '30d', q: 'болела' },
        onPeriod: () => undefined,
        onArm: () => undefined,
        onNoted: () => undefined,
        onReset: () => undefined,
        onRange: () => undefined,
        onQuery: () => undefined,
      }),
    );
    expect(screen.getByTestId<HTMLInputElement>('filter-query').value).toBe('болела');

    rerender(
      createElement(HistoryFilters, {
        state: { period: '30d' },
        onPeriod: () => undefined,
        onArm: () => undefined,
        onNoted: () => undefined,
        onReset: () => undefined,
        onRange: () => undefined,
        onQuery: () => undefined,
      }),
    );
    expect(screen.getByTestId<HTMLInputElement>('filter-query').value).toBe('');
    expect(screen.queryByTestId('filter-query-clear')).toBeNull();
  });
});
