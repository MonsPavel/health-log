/**
 * TASK-060 §5/§16/§17/§19: тесты обучающей заглушки пустого периода графика.
 *
 * Матрица (§5/§19): иконка декоративна (aria-hidden, прецедент EmptyHistory
 * TASK-033); заголовок «За выбранный период измерений нет» (§5); подсказка-
 * альтернатива + действие «Показать всё время» → период all (§5 УПРОЩЕНИЕ: оба
 * действия всегда, без второго запроса — о записях вне периода не спрашиваем);
 * на периоде all действие-нооп скрыто (честность §13: записей нет вовсе —
 * «показать всё» не предлагается); CTA «Добавить измерение» — обычная кнопка
 * tab-порядка (§16), клик → журнал (§20 AC1: CTA работает).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmptyChartState } from './EmptyChartState';

import '../../../i18n';

afterEach(() => cleanup());

describe('EmptyChartState — обучающая заглушка пустого периода (§5/§19/§20 AC1)', () => {
  it('(§5) иконка (aria-hidden) + заголовок «За выбранный период измерений нет» + подсказка + оба действия', () => {
    render(
      createElement(EmptyChartState, {
        onAdd: () => undefined,
        onShowAll: () => undefined,
        showAllTime: true,
      }),
    );

    const empty = screen.getByTestId('empty-chart');
    expect(empty.textContent).toContain('За выбранный период измерений нет');
    expect(empty.textContent).toContain('Покажите всё время');
    // Иконка — декоративный элемент вне доступа скринридера (§16).
    const icon = empty.querySelector('span[aria-hidden="true"]');
    expect(icon).not.toBeNull();
    expect(icon?.textContent?.length ?? 0).toBeGreaterThan(0);
    // Оба действия (§5 УПРОЩЕНИЕ) — обычные кнопки tab-порядка (§16).
    expect(screen.getByRole('button', { name: 'Добавить измерение' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Показать всё время' })).not.toBeNull();
  });

  it('(§20 AC1) CTA «Добавить измерение» → колбэк добавления (журнал/форма)', () => {
    const onAdd = vi.fn();
    render(
      createElement(EmptyChartState, { onAdd, onShowAll: () => undefined, showAllTime: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Добавить измерение' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('(§5) «Показать всё время» → колбэк смены периода на all', () => {
    const onShowAll = vi.fn();
    render(
      createElement(EmptyChartState, { onAdd: () => undefined, onShowAll, showAllTime: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Показать всё время' }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it('(§13 честность) showAllTime=false (период уже all): «Показать всё время» и подсказка скрыты, CTA остаётся', () => {
    render(
      createElement(EmptyChartState, {
        onAdd: () => undefined,
        onShowAll: () => undefined,
        showAllTime: false,
      }),
    );

    expect(screen.queryByRole('button', { name: 'Показать всё время' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Добавить измерение' })).not.toBeNull();
    expect(screen.getByTestId('empty-chart').textContent).toContain(
      'За выбранный период измерений нет',
    );
  });
});
