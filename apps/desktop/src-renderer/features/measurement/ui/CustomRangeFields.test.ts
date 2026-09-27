/**
 * TASK-046 §5/§16/§17/§19: тесты полей произвольного периода.
 *
 * Компонент (§5/§10): два нативных input type=date (TD-11) с labels «С»/«По»
 * (§17 filters.custom.from/to); значения — проп-состояние (URL→поля, §19),
 * валидный ввод — колбэк onApply немедленно (авто-применение, §19); черновик —
 * локальное состояние, синхронизируется с внешним (сброс/смена фильтров).
 *
 * Валидация (§19/§20): from > to → текст invalidOrder, onApply НЕ вызывается
 * (invalid-состояние блокирует применение, AC2); to в будущем → futureTo (AC3,
 * EC-20); исправление значения снимает ошибку и применяет диапазон.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { CustomRangeFields } from './CustomRangeFields';

/** Свойства рендера: применённое состояние (пропсы) + колбэк. */
function renderFields(
  state: { readonly from?: string; readonly to?: string } = {},
  onApply: (from: string | undefined, to: string | undefined) => void = () => undefined,
): void {
  render(
    createElement(CustomRangeFields, {
      from: state.from,
      to: state.to,
      onApply,
    }),
  );
}

/** Ввод даты в поле (controlled input — fireEvent.change, прецедент поиска). */
function typeDate(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId<HTMLInputElement>(testId), { target: { value } });
}

afterEach(() => {
  cleanup();
});

describe('CustomRangeFields — структура и a11y (§16/§17)', () => {
  it('два input type=date с labels «С»/«По» из каталога (filters.custom.from/to)', () => {
    renderFields();

    const from = screen.getByLabelText('С');
    const to = screen.getByLabelText('По');
    expect(from.getAttribute('type')).toBe('date');
    expect(to.getAttribute('type')).toBe('date');
    expect(screen.getByTestId('filter-range-from')).toBe(from);
    expect(screen.getByTestId('filter-range-to')).toBe(to);
  });

  it('поля восстановлены из применённого состояния (URL→поля, §19/AC5)', () => {
    renderFields({ from: '2026-03-01', to: '2026-03-15' });

    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('2026-03-01');
    expect(screen.getByTestId<HTMLInputElement>('filter-range-to').value).toBe('2026-03-15');
  });

  it('axe: поля без critical-нарушений (§16)', async () => {
    const { container } = render(
      createElement(CustomRangeFields, {
        from: '2026-03-01',
        to: '2026-03-15',
        onApply: () => undefined,
      }),
    );

    const results = await axe.run(container);
    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});

describe('CustomRangeFields — валидный ввод применяется (§10/§19)', () => {
  it('ввод «С» при пустом «По» — прогрессивно: onApply(from, undefined) (§10)', () => {
    const onApply = vi.fn();
    renderFields({}, onApply);

    typeDate('filter-range-from', '2026-03-01');

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith('2026-03-01', undefined);
  });

  it('ввод «По» после «С» — полная пара: onApply(from, to)', () => {
    const onApply = vi.fn();
    renderFields({ from: '2026-03-01' }, onApply);

    typeDate('filter-range-to', '2026-03-15');

    expect(onApply).toHaveBeenCalledWith('2026-03-01', '2026-03-15');
  });

  it('очистка обоих полей → onApply(undefined, undefined) (пустые оба, §10)', () => {
    const onApply = vi.fn();
    renderFields({ from: '2026-03-01', to: '2026-03-15' }, onApply);

    typeDate('filter-range-from', '');
    expect(onApply).toHaveBeenLastCalledWith(undefined, '2026-03-15');

    typeDate('filter-range-to', '');
    expect(onApply).toHaveBeenLastCalledWith(undefined, undefined);
  });
});

describe('CustomRangeFields — invalid-состояние блокирует применение (§19/§20 AC2/AC3)', () => {
  it('from > to → текст invalidOrder с aria, onApply НЕ вызван (AC2)', () => {
    const onApply = vi.fn();
    renderFields({ from: '2026-03-15' }, onApply);

    typeDate('filter-range-to', '2026-03-01');

    expect(onApply).not.toHaveBeenCalled();
    const error = screen.getByTestId('filter-range-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe('«С» позже «По» — исправьте диапазон');
    // §16: ошибка связана с полями aria-describedby, поля помечены aria-invalid.
    expect(screen.getByTestId('filter-range-from').getAttribute('aria-describedby')).toBe(
      'filter-range-error',
    );
    expect(screen.getByTestId('filter-range-to').getAttribute('aria-describedby')).toBe(
      'filter-range-error',
    );
    expect(screen.getByTestId('filter-range-from').getAttribute('aria-invalid')).toBe('true');
  });

  it('to в будущем → текст futureTo, onApply НЕ вызван (AC3, EC-20)', () => {
    const onApply = vi.fn();
    renderFields({ from: '2026-03-01' }, onApply);

    typeDate('filter-range-to', '2026-12-31');

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId('filter-range-error').textContent).toBe(
      '«По» не может быть в будущем',
    );
    // futureTo — ошибка поля «По»: aria-describedby на нём.
    expect(screen.getByTestId('filter-range-to').getAttribute('aria-describedby')).toBe(
      'filter-range-error',
    );
    expect(screen.getByTestId('filter-range-from').getAttribute('aria-describedby')).toBeNull();
  });

  it('исправление значения снимает ошибку и применяет диапазон', () => {
    const onApply = vi.fn();
    renderFields({ from: '2026-03-15' }, onApply);

    typeDate('filter-range-to', '2026-03-01');
    expect(screen.getByTestId('filter-range-error')).toBeDefined();
    expect(onApply).not.toHaveBeenCalled();

    typeDate('filter-range-to', '2026-03-20');
    expect(screen.queryByTestId('filter-range-error')).toBeNull();
    expect(onApply).toHaveBeenCalledWith('2026-03-15', '2026-03-20');
    expect(screen.getByTestId('filter-range-from').getAttribute('aria-invalid')).toBeNull();
  });
});

describe('CustomRangeFields — синхронизация с внешним состоянием (§12)', () => {
  it('внешняя смена применённых значений (сброс фильтров) обновляет поля и снимает ошибку', () => {
    const onApply = vi.fn();
    const props = {
      from: '2026-03-01' as string | undefined,
      to: '2026-03-20' as string | undefined,
      onApply,
    };
    const { rerender } = render(createElement(CustomRangeFields, props));
    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('2026-03-01');

    typeDate('filter-range-from', '2026-03-25'); // invalid: from > to
    expect(screen.getByTestId('filter-range-error')).toBeDefined();

    // Сброс фильтров снаружи: применённые даты ушли.
    rerender(createElement(CustomRangeFields, { ...props, from: undefined, to: undefined }));
    expect(screen.getByTestId<HTMLInputElement>('filter-range-from').value).toBe('');
    expect(screen.getByTestId<HTMLInputElement>('filter-range-to').value).toBe('');
    expect(screen.queryByTestId('filter-range-error')).toBeNull();
  });
});
