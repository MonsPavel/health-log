/**
 * TASK-058 §5/§10/§13/§16/§19/§20: компонентные тесты PulseChart — графика ЧСС
 * вкладки «Пульс».
 *
 * Матрица (§19/§20): ось подписана единицей «уд/мин»; коридор 60–100 виден —
 * полупрозрачная полоса + линии-границы ИЗ КОНСТАНТ КОНТРАКТА (не хардкод:
 * pulseYDomainOf проверяется против импортированных PULSE_REF_LOW/HIGH); точки
 * без пульса пропущены, подпись скрытых честная (AC2: 2 записи без пульса из 5 →
 * «2 не показаны»; daily — Σcount − ΣpulseCount); irregular-запись —
 * маркер-кольцо (форма, не только цвет — §16) на точке и полный aria-label
 * строки мини-таблицы; переход к правке — как на давлении (клик точки/строки);
 * daily — среднее за день, правки нет; a11y — figure role="img" с резюме из
 * загруженных данных (прецедент TrendChart 057: stats/period экран не потребляет).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PULSE_REF_HIGH, PULSE_REF_LOW, type RawPoint } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { PULSE_DAYS } from './__fixtures__/dashboard';
import { hiddenPulseCountOf, pulseYDomainOf, PulseChart } from './PulseChart';

import '../../../i18n';

afterEach(() => cleanup());

/** Точка ЧСС фикстуры (id обязателен — переход к правке). */
function pulsePoint(
  seq: number,
  pulse: number | undefined,
  irregular = false,
  hour = 8,
): RawPoint {
  return {
    utcMs: Date.UTC(2026, 8, 1 + seq, hour, 0),
    tzOffsetMin: 180,
    sys: 120 + seq,
    dia: 80,
    ...(pulse === undefined ? {} : { pulse }),
    part: 'morning',
    ...(irregular ? { irregular: true } : {}),
    id: `rec-${seq}`,
  };
}

/** AC2 (§13): 5 записей, 2 без пульса, одна с irregular (EC-10). */
const FIVE_POINTS: readonly RawPoint[] = [
  pulsePoint(0, 62),
  pulsePoint(1, 70, true),
  pulsePoint(2, undefined),
  pulsePoint(3, 75),
  pulsePoint(4, undefined, false, 20),
];

describe('pulseYDomainOf — правило оси Y (§5: коридор из констант контракта, не хардкод)', () => {
  it('данные внутри коридора: ось ровно [PULSE_REF_LOW, PULSE_REF_HIGH] — константы видны', () => {
    expect(pulseYDomainOf([70, 80, 90])).toEqual([PULSE_REF_LOW, PULSE_REF_HIGH]);
  });

  it('данные выходят за коридор: границы коридора включены, padding ±10 вокруг данных', () => {
    expect(pulseYDomainOf([45, 120])).toEqual([35, 130]);
    expect(pulseYDomainOf([PULSE_REF_LOW, PULSE_REF_HIGH])).toEqual([
      PULSE_REF_LOW - 10,
      PULSE_REF_HIGH + 10,
    ]);
  });

  it('пустой вход: коридор в домене (пустые данные не ломают график)', () => {
    expect(pulseYDomainOf([])).toEqual([PULSE_REF_LOW - 10, PULSE_REF_HIGH + 10]);
  });
});

describe('hiddenPulseCountOf — скрытые записи без пульса (§13: честная разница)', () => {
  it('raw: точки с pulse undefined считаются скрытыми (2 из 5)', () => {
    expect(hiddenPulseCountOf({ mode: 'raw', points: [...FIVE_POINTS] })).toBe(2);
  });

  it('raw: все с пульсом — скрытых нет', () => {
    expect(hiddenPulseCountOf({ mode: 'raw', points: [pulsePoint(0, 62), pulsePoint(1, 70)] })).toBe(
      0,
    );
  });

  it('daily: Σcount − ΣpulseCount (день без pulseCount — все его записи скрыты)', () => {
    // 6 записей, с пульсом 3 → скрыто 3.
    expect(hiddenPulseCountOf({ mode: 'daily', days: [...PULSE_DAYS] })).toBe(3);
  });
});

describe('PulseChart — raw-режим (§20 AC1/AC2/AC3/AC4)', () => {
  it('(AC1) линия ЧСС одна, коридор виден: полупрозрачная полоса + две линии-границы, ось подписана «уд/мин»', () => {
    const { container } = render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );

    expect(container.querySelectorAll('.recharts-line')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-reference-area')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(2);
    const svgText = container.querySelector('svg')?.textContent ?? '';
    expect(svgText).toContain('уд/мин');
  });

  it('(AC2) 2 записи без пульса из 5 → подпись «2 измерения без пульса не показаны»; все с пульсом — подписи нет', () => {
    render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );
    expect(screen.getByTestId('pulse-hidden-count').textContent).toBe(
      '2 измерения без пульса не показаны',
    );
    cleanup();

    render(
      createElement(PulseChart, {
        response: {
          mode: 'raw',
          points: [pulsePoint(0, 62), pulsePoint(1, 70), pulsePoint(2, 75)],
        },
        periodLabel: '30 дней',
      }),
    );
    expect(screen.queryByTestId('pulse-hidden-count')).toBeNull();
  });

  it('(AC2) точки без пульса пропущены: маркеров 3 (по числу записей с пульсом), строк мини-таблицы 3', () => {
    const { container } = render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );

    expect(container.querySelectorAll('[data-testid="pulse-dot"]').length).toBe(3);
    expect(screen.getAllByTestId('pulse-list-row').length).toBe(3);
  });

  it('(AC3) irregular-запись — маркер-кольцо на точке (форма, не только цвет); у остальных кольца нет', () => {
    const { container } = render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );

    expect(container.querySelectorAll('[data-testid="pulse-dot-irregular"]').length).toBe(1);
    // Кольцо — отдельный элемент формы вокруг маркера (§16: не только цвет).
    expect(container.querySelector('[data-testid="pulse-dot-irregular"]')?.tagName).toBe('circle');
  });

  it('(AC4) клик по точке → onEditPoint с этой записью; клик строки мини-таблицы → onEditPoint', () => {
    const onEditPoint = vi.fn();
    const { container } = render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
        onEditPoint,
      }),
    );

    const firstDot = container.querySelector('[data-testid="pulse-dot"]');
    if (firstDot === null) {
      throw new Error('маркер точки ЧСС обязан быть в DOM (raw с пульсом)');
    }
    fireEvent.click(firstDot);
    expect(onEditPoint).toHaveBeenCalledWith(FIVE_POINTS[0]);

    const rows = screen.getAllByTestId('pulse-list-row');
    fireEvent.click(rows[1]);
    expect(onEditPoint).toHaveBeenCalledWith(FIVE_POINTS[1]);
  });

  it('(AC3/§16) aria-label irregular-строки полный: пульс, единица, пояс EC-10; обычной — без пояса', () => {
    render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );

    const rows = screen.getAllByTestId('pulse-list-row');
    const irregularRow = rows[1];
    if (irregularRow === undefined) {
      throw new Error('строка irregular-записи обязана быть в мини-таблице');
    }
    expect(irregularRow.getAttribute('aria-label')).toContain(
      'неровный пульс — значение может быть неточным',
    );
    expect(irregularRow.getAttribute('aria-label')).toContain(
      formatDateTime(FIVE_POINTS[1], { preset: 'datetime' }),
    );
    const regularRow = rows[0];
    if (regularRow === undefined) {
      throw new Error('строка точки обязана быть в мини-таблице');
    }
    expect(regularRow.getAttribute('aria-label')).not.toContain('неровный пульс');
  });

  it('(§16) figure role="img": резюме из загруженных данных (среднее/диапазон/число показанных) + refNote ВНЕ svg и ВНЕ aria-hidden', () => {
    const { container } = render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );

    const figure = screen.getByTestId('pulse-chart');
    expect(figure.getAttribute('role')).toBe('img');
    const label = figure.getAttribute('aria-label') ?? '';
    expect(label).toContain('30 дней');
    expect(label).toContain('в среднем 69'); // (62+70+75)/3 = 69
    expect(label).toContain('62');
    expect(label).toContain('75');
    expect(label).toContain('точек: 3');

    // Ревью-прецедент 057: подпись коридора — ВНЕ <svg> и ВНЕ aria-hidden-обёртки.
    const refNote = screen.getByTestId('pulse-ref-note');
    expect(refNote.textContent).toContain('справка, не классификация');
    expect(container.querySelector('svg')?.contains(refNote) ?? false).toBe(false);
    expect(refNote.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('легенда текстовая: серия «Пульс» + кольцо «Неровный пульс» (§16)', () => {
    render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [...FIVE_POINTS] },
        periodLabel: '30 дней',
      }),
    );

    const legend = screen.getByTestId('pulse-legend');
    expect(legend.textContent).toContain('Пульс');
    expect(legend.textContent).toContain('Неровный пульс');
  });
});

describe('PulseChart — daily-режим (§5: avg + коридор; правки нет)', () => {
  it('(AC1) линия pulseAvg одна, коридор виден, подпись агрегации, легенда «Среднее за день»', () => {
    const { container } = render(
      createElement(PulseChart, {
        response: { mode: 'daily', days: [...PULSE_DAYS] },
        periodLabel: '90 дней',
      }),
    );

    expect(container.querySelectorAll('.recharts-line')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-reference-area')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(2);
    expect(screen.getByTestId('pulse-daily-caption').textContent).toContain('Агрегировано по дням');
    const legend = screen.getByTestId('pulse-legend');
    expect(legend.textContent).toContain('Среднее за день');
  });

  it('(AC2) daily: скрытых 3 записи из PULSE_DAYS → «3 измерения без пульса не показаны»; правки нет', () => {
    render(
      createElement(PulseChart, {
        response: { mode: 'daily', days: [...PULSE_DAYS] },
        periodLabel: '90 дней',
      }),
    );

    expect(screen.getByTestId('pulse-hidden-count').textContent).toBe(
      '3 измерения без пульса не показаны',
    );
    expect(screen.queryByTestId('pulse-list')).toBeNull();
  });

  it('a11y: резюме daily — среднее/диапазон по pulseAvg, точек = дней с пульсом', () => {
    render(
      createElement(PulseChart, {
        response: { mode: 'daily', days: [...PULSE_DAYS] },
        periodLabel: '90 дней',
      }),
    );

    const label = screen.getByTestId('pulse-chart').getAttribute('aria-label') ?? '';
    expect(label).toContain('90 дней');
    expect(label).toContain('в среднем 63,8'); // (61.5 + 66)/2 = 63.75 → 63.8
    expect(label).toContain('точек: 2');
  });

  it('§13 пограничный: пульса нет вовсе — график с коридором, скрыты все, резюме без чисел', () => {
    render(
      createElement(PulseChart, {
        response: { mode: 'raw', points: [pulsePoint(0, undefined), pulsePoint(1, undefined)] },
        periodLabel: '30 дней',
      }),
    );

    const label = screen.getByTestId('pulse-chart').getAttribute('aria-label') ?? '';
    expect(label).toContain('измерений с пульсом нет');
    expect(screen.getByTestId('pulse-hidden-count').textContent).toBe(
      '2 измерения без пульса не показаны',
    );
  });
});
