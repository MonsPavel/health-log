/**
 * TASK-059 §5/§19/§20: компонентные тесты таблицы-альтернативы графику.
 *
 * Матрица (§20): колонки §5 — Дата-время (Intl), СДА, ДДА, ЧСС, Рука, Флаги
 * (бейджи TASK-042 переиспользование); сортировка по клику заголовка — дата
 * asc/desc, sys, dia (простая сортировка загруженных точек, сервер не трогаем);
 * aria-sort обновляется (§16); caption с периодом + th scope (§16); daily-режим —
 * дневная таблица (день, avg±, min–max, count); пустые состояния («Нет данных за
 * период», TASK-060-текст). Скринридер-симуляция — не автоматизируем (§19,
 * P7-чеклист TASK-109); axe — на уровне экрана (DashboardScreen.a11y.test.ts).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { RawPoint, TrendResponse } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { TREND_DAYS } from './__fixtures__/dashboard';
import { TrendTable } from './TrendTable';

import '../../../i18n';

afterEach(() => cleanup());

/** Компактная фикстура: рука обеих сторон, пульс «есть/нет», все три флага. */
const POINTS: readonly RawPoint[] = [
  {
    utcMs: Date.UTC(2026, 2, 1, 7, 0),
    tzOffsetMin: 180,
    sys: 120,
    dia: 78,
    pulse: 62,
    part: 'morning',
    arm: 'left',
    critical: 'high',
    irregular: true,
    id: 'r1',
  },
  {
    utcMs: Date.UTC(2026, 2, 1, 20, 0),
    tzOffsetMin: 180,
    sys: 132,
    dia: 85,
    part: 'evening',
    arm: 'right',
    id: 'r2',
  },
  {
    utcMs: Date.UTC(2026, 2, 2, 8, 30),
    tzOffsetMin: 180,
    sys: 126,
    dia: 82,
    pulse: 70,
    part: 'other',
    id: 'r3',
  },
];

const renderTable = (response: TrendResponse, periodLabel = '30 дней'): void => {
  render(createElement(TrendTable, { response, periodLabel }));
};

/** Тексты строк таблицы (td) в порядке DOM — сортировка видна по значениям. */
const rowValues = (): string[][] =>
  screen
    .getAllByTestId('trend-table-row')
    .map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? ''));

describe('TrendTable — raw-режим: колонки §5 и значения', () => {
  it('(AC2) колонки: Дата-время, СДА, ДДА, ЧСС, Рука, Флаги; caption с периодом; th scope="col"', () => {
    renderTable({ mode: 'raw', points: [...POINTS] });

    const table = screen.getByTestId('trend-table');
    const headers = Array.from(table.querySelectorAll('thead th'));
    expect(headers.map((th) => th.textContent)).toEqual([
      'Дата и время',
      'СДА, мм рт. ст.',
      'ДДА, мм рт. ст.',
      'ЧСС, уд/мин',
      'Рука',
      'Отметки',
    ]);
    for (const th of headers) {
      expect(th.getAttribute('scope')).toBe('col');
    }
    // §16: caption несёт период (params период — §17).
    expect(screen.getByTestId('trend-table-caption').textContent).toContain('30 дней');
  });

  it('(AC2) значения строки: Intl-дата, СДА/ДДА/ЧСС, рука localized; пульс «не измерен» — прочерк', () => {
    renderTable({ mode: 'raw', points: [...POINTS] });

    const rows = rowValues();
    const first = POINTS[0];
    const second = POINTS[1];
    if (first === undefined || second === undefined) {
      throw new Error('фикстура обязана содержать минимум 2 точки');
    }
    expect(rows[0]?.slice(0, 5)).toEqual([
      formatDateTime(
        { utcMs: first.utcMs, tzOffsetMin: first.tzOffsetMin },
        { preset: 'datetime' },
      ),
      '120',
      '78',
      '62',
      'Левая',
    ]);
    expect(rows[1]?.slice(0, 5)).toEqual([
      formatDateTime(
        { utcMs: second.utcMs, tzOffsetMin: second.tzOffsetMin },
        { preset: 'datetime' },
      ),
      '132',
      '85',
      '—',
      'Правая',
    ]);
  });

  it('флаги — бейджи TASK-042 (переиспользование): critical/irregular бейджи с aria-label; строка без флагов — их нет', () => {
    renderTable({ mode: 'raw', points: [...POINTS] });

    const rows = screen.getAllByTestId('trend-table-row');
    const first = rows[0];
    const second = rows[1];
    const third = rows[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('фикстура обязана содержать 3 точки');
    }
    const firstBadges = within(first);
    expect(firstBadges.getByTestId('flag-critical').getAttribute('aria-label')).toContain('120');
    expect(firstBadges.getByTestId('flag-critical').getAttribute('aria-label')).toContain('78');
    expect(firstBadges.getByTestId('flag-irregular')).not.toBeNull();
    expect(within(second).queryByTestId('flag-critical')).toBeNull();
    expect(within(second).queryByTestId('flag-irregular')).toBeNull();
    expect(within(third).queryByTestId('flag-critical')).toBeNull();
  });

  it('сортировка по умолчанию — дата asc (хронология графика); th даты несёт aria-sort="ascending" (§16)', () => {
    renderTable({ mode: 'raw', points: [...POINTS].reverse() });

    expect(rowValues().map((cells) => cells[1])).toEqual(['120', '132', '126']);
    const dateTh = screen.getByTestId('trend-sort-date').closest('th');
    expect(dateTh?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('(AC2) клик «СДА» → сортировка sys asc + aria-sort="ascending"; повторный клик → desc + aria-sort="descending"', () => {
    renderTable({ mode: 'raw', points: [...POINTS] });

    fireEvent.click(screen.getByTestId('trend-sort-sys'));
    expect(rowValues().map((cells) => cells[1])).toEqual(['120', '126', '132']);
    const sysTh = screen.getByTestId('trend-sort-sys').closest('th');
    expect(sysTh?.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(screen.getByTestId('trend-sort-sys'));
    expect(rowValues().map((cells) => cells[1])).toEqual(['132', '126', '120']);
    expect(screen.getByTestId('trend-sort-sys').closest('th')?.getAttribute('aria-sort')).toBe(
      'descending',
    );
  });

  it('клик «ДДА» → сортировка dia asc; aria-sort переезжает с прежнего столбца', () => {
    renderTable({ mode: 'raw', points: [...POINTS] });

    fireEvent.click(screen.getByTestId('trend-sort-dia'));
    expect(rowValues().map((cells) => cells[2])).toEqual(['78', '82', '85']);
    expect(screen.getByTestId('trend-sort-dia').closest('th')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(
      screen.getByTestId('trend-sort-date').closest('th')?.getAttribute('aria-sort'),
    ).toBeNull();
  });

  it('клик «Дата и время» после сортировки по значению — возврат к дате (asc → desc чередуется)', () => {
    renderTable({ mode: 'raw', points: [...POINTS] });

    fireEvent.click(screen.getByTestId('trend-sort-sys'));
    fireEvent.click(screen.getByTestId('trend-sort-date'));
    expect(rowValues().map((cells) => cells[1])).toEqual(['120', '132', '126']);
    expect(screen.getByTestId('trend-sort-date').closest('th')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
    fireEvent.click(screen.getByTestId('trend-sort-date'));
    expect(rowValues().map((cells) => cells[1])).toEqual(['126', '132', '120']);
    expect(screen.getByTestId('trend-sort-date').closest('th')?.getAttribute('aria-sort')).toBe(
      'descending',
    );
  });
});

describe('TrendTable — daily-режим: дневная таблица (§5: день, avg±, min–max, count)', () => {
  it('колонки День/СДА/ДДА/Измерений; ячейка «avg (min–max)»; count дня; сортировки нет (read model отдаёт wallDate asc)', () => {
    renderTable({ mode: 'daily', days: [...TREND_DAYS] });

    const table = screen.getByTestId('trend-table');
    expect(Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
      'День',
      'СДА, мм рт. ст.',
      'ДДА, мм рт. ст.',
      'Измерений',
    ]);
    expect(table.querySelectorAll('button')).toHaveLength(0);

    const rows = rowValues();
    expect(rows[0]).toEqual(['01.03.2026', '122 (118–128)', '79 (76–82)', '3']);
    // Дробное среднее — ru-формат (правило отображения 052: максимум 1 знак).
    expect(rows[1]).toEqual(['02.03.2026', '124,5 (120–130)', '81 (78–85)', '2']);
    expect(rows[2]).toEqual(['03.03.2026', '121 (121–121)', '80 (80–80)', '1']);
  });

  it('пустые days → пустое состояние «За выбранный период измерений нет» (общий ключ TASK-060), таблицы нет', () => {
    renderTable({ mode: 'daily', days: [] });

    expect(screen.getByTestId('trend-table-empty').textContent).toContain(
      'За выбранный период измерений нет',
    );
    expect(screen.queryByTestId('trend-table')).toBeNull();
  });
});

describe('TrendTable — пустой raw-период (§13)', () => {
  it('пустые points → пустое состояние «За выбранный период измерений нет», таблицы нет', () => {
    renderTable({ mode: 'raw', points: [] });

    expect(screen.getByTestId('trend-table-empty').textContent).toContain(
      'За выбранный период измерений нет',
    );
    expect(screen.queryByTestId('trend-table')).toBeNull();
  });
});
