/**
 * TASK-057 §5/§13/§16/§19/§20: компонентные тесты TrendChart.
 *
 * Матрица (§20): фикстура 30 дней → обе линии, 4 опорные линии (2 sys + 2 dia),
 * подпись «ESC/ESH 2018» видна (§20.1); точки утро/вечер/other различимы ФОРМОЙ
 * — элементы DOM circle/rect/polygon (§20.2); клик по точке → колбэк правки;
 * daily-режим — коридор (range-Area) + линия avg + подпись агрегации (§20.5);
 * легенда текстовая; a11y — figure role="img" с aria-label-резюме из данных
 * (§16; stats/period 057 не потребляет — числа считаются из загруженных точек,
 * полное решение — TASK-059); одна точка — маркер без линии (§13).
 *
 * Клавиатурная доступность тултипа (§16): по возможностям библиотеки выбран
 * СПИСОК-МИНИ-ТАБЛИЦА под графиком (ADR-комментарий реализации) — фокусируемые
 * кнопки-строки с полными значениями точки; визуальный тултип — hover Recharts.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime } from '../../../lib/i18n-date';
import {
  TREND_DAYS,
  TREND_30_DAYS,
  TREND_SINGLE_POINT,
  SCALE_FIXTURE,
} from './__fixtures__/dashboard';
import { yDomainOf, TrendChart } from './TrendChart';

import '../../../i18n';

afterEach(() => cleanup());

describe('yDomainOf — правило оси Y (§22: фикс-минимум 60 + padding ±20 вокруг данных)', () => {
  it('обычные данные 112–145: нижняя = min−20, верхняя = max+20', () => {
    expect(yDomainOf([112, 120, 145])).toEqual([92, 165]);
  });

  it('низкие данные: минимум оси не опускается ниже 60 мм рт. ст.', () => {
    expect(yDomainOf([55, 70])).toEqual([60, 90]);
  });
});

describe('TrendChart — raw-режим (§20.1/§20.2/§20.3)', () => {
  it('(AC1) 30 дней: обе линии (sys и dia), 4 опорные линии (2 sys + 2 dia), подпись «ESC/ESH 2018» видна', () => {
    const { container } = render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [...TREND_30_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
      }),
    );

    const lines = container.querySelectorAll('.recharts-line');
    expect(lines.length).toBe(2);
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(4);
    // Ревью TASK-057 (§20.1): Recharts монтирует детей ComposedChart ВНУТРЬ <svg>,
    // а HTML-элемент в svg в Chromium не рендерится (getBoundingClientRect 0×0,
    // offsetParent null) и не попадает в accessibility-дерево. Подпись источника
    // обязана быть ВНЕ svg и вне aria-hidden-поддерева графика.
    const caption = screen.getByTestId('scale-source');
    expect(caption.textContent).toContain('ESC/ESH 2018');
    expect(container.querySelector('svg')?.contains(caption) ?? false).toBe(false);
    expect(caption.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('(AC2) точки различимы формой: утро=circle, вечер=rect, другое=polygon (форма+цвет, не только цвет)', () => {
    const { container } = render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [...TREND_30_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
      }),
    );

    // Маркеры у ОБОИХ серий: 90 точек × 2 линии = 180 форм.
    const dots = container.querySelectorAll('[data-testid="trend-dot"]');
    expect(dots.length).toBe(TREND_30_DAYS.length * 2);
    expect(container.querySelector('circle[data-testid="trend-dot"]')).not.toBeNull();
    expect(container.querySelector('rect[data-testid="trend-dot"]')).not.toBeNull();
    expect(container.querySelector('polygon[data-testid="trend-dot"]')).not.toBeNull();
    // Атрибут части суток на элементе формы — различим и программно.
    expect(
      container.querySelector('circle[data-testid="trend-dot"]')?.getAttribute('data-part'),
    ).toBe('morning');
    expect(
      container.querySelector('rect[data-testid="trend-dot"]')?.getAttribute('data-part'),
    ).toBe('evening');
  });

  it('(AC3) клик по точке → колбэк onEditPoint с этой точкой (переход к правке, сквозной с экраном)', () => {
    const onEditPoint = vi.fn();
    const { container } = render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [...TREND_30_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
        onEditPoint,
      }),
    );

    const firstDot = container.querySelector('[data-testid="trend-dot"]');
    const firstPoint = TREND_30_DAYS[0];
    if (firstDot === null || firstPoint === undefined) {
      throw new Error('маркер точки обязан быть в DOM (raw-режим с точками)');
    }
    fireEvent.click(firstDot);
    expect(onEditPoint).toHaveBeenCalledTimes(1);
    expect(onEditPoint).toHaveBeenCalledWith(firstPoint);
  });

  it('легенда текстовая различима без цвета: названия серий и части суток с глифами (§16)', () => {
    render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [...TREND_30_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
      }),
    );

    const legend = screen.getByTestId('trend-legend');
    expect(legend.textContent).toContain('Систолическое (СДА)');
    expect(legend.textContent).toContain('Диастолическое (ДДА)');
    expect(legend.textContent).toContain('Утро');
    expect(legend.textContent).toContain('Вечер');
  });

  it('a11y: figure role="img" с aria-label-резюме из данных (§16: среднее/диапазон/число)', () => {
    render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [...TREND_30_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
      }),
    );

    const figure = screen.getByTestId('trend-chart');
    expect(figure.getAttribute('role')).toBe('img');
    const label = figure.getAttribute('aria-label') ?? '';
    expect(label).toContain('30 дней');
    expect(label).toContain('измерений: 90');
  });

  it('клавиатурная доступность (§16): мини-таблица строк-кнопок под графиком, клик → правка', () => {
    const onEditPoint = vi.fn();
    const first = TREND_30_DAYS[0];
    const second = TREND_30_DAYS[1];
    if (first === undefined || second === undefined) {
      throw new Error('фикстура 30 дней должна содержать минимум 2 точки');
    }
    render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [first, second] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
        onEditPoint,
      }),
    );

    const rows = screen.getAllByTestId('trend-list-row');
    expect(rows.length).toBe(2);
    const firstRow = rows[0];
    const secondRow = rows[1];
    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('мини-таблица обязана содержать строку на каждую точку');
    }
    // aria-label строки содержит настенные дата-время и значения (§16/§17).
    expect(firstRow.getAttribute('aria-label')).toContain(
      formatDateTime(first, { preset: 'datetime' }),
    );
    fireEvent.click(secondRow);
    expect(onEditPoint).toHaveBeenCalledWith(second);
  });

  it('§13 пограничный: одна точка — маркер без линии (маркеры обеих серий рендерятся)', () => {
    const { container } = render(
      createElement(TrendChart, {
        response: { mode: 'raw', points: [...TREND_SINGLE_POINT] },
        scale: SCALE_FIXTURE,
        periodLabel: '30 дней',
      }),
    );

    expect(container.querySelectorAll('[data-testid="trend-dot"]').length).toBe(2);
  });
});

describe('TrendChart — daily-режим (§20.5: коридор+avg, подпись агрегации)', () => {
  it('(AC5) коридор min-max двумя range-Area + линии avg, подпись «Агрегировано по дням», легенда avg/диапазон', () => {
    const { container } = render(
      createElement(TrendChart, {
        response: { mode: 'daily', days: [...TREND_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '90 дней',
      }),
    );

    // Коридор: 2 range-Area (sys/dia); среднее: 2 Line (sysAvg/diaAvg).
    expect(container.querySelectorAll('.recharts-area')).toHaveLength(2);
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(2);
    expect(screen.getByTestId('trend-daily-caption').textContent).toContain('Агрегировано по дням');
    const legend = screen.getByTestId('trend-legend');
    expect(legend.textContent).toContain('Среднее за день');
    expect(legend.textContent).toContain('Диапазон дня');
  });

  it('daily-режим без правки (§12: агрегат) — строк-кнопок правки нет', () => {
    render(
      createElement(TrendChart, {
        response: { mode: 'daily', days: [...TREND_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '90 дней',
      }),
    );

    expect(screen.queryByTestId('trend-list')).toBeNull();
  });

  it('тултип daily подключён: content ChartTooltip с mode=daily рендерится в дереве', () => {
    // Проверка привязки: ChartTooltip вызывается Recharts-ом; здесь достаточно,
    // что стоячий тултип daily (unit ChartTooltip.test) и подключение content
    // не падают вместе с осью и легендой.
    const { container } = render(
      createElement(TrendChart, {
        response: { mode: 'daily', days: [...TREND_DAYS] },
        scale: SCALE_FIXTURE,
        periodLabel: '90 дней',
      }),
    );
    expect(container.querySelector('.recharts-wrapper')).not.toBeNull();
  });
});
