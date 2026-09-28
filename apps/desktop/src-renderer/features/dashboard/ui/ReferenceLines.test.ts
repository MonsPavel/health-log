/**
 * TASK-057 §5/§13/§19: тесты ReferenceLines — опорные линии границ шкалы ИЗ ДАННЫХ
 * (не хардкод: sys-порог high_normal/hypertension1 = sysRange.min категорий активной
 * шкалы; dia — diaRange.min, §13) + подпись источника ОДИН РАЗ НА ГРАФИК (§13).
 *
 * referenceThresholdsOf — чистая функция (извлечение порогов, §7); компонент —
 * 4 <ReferenceLine> внутри графика (2 sys + 2 dia, §20.1) + caption источника
 * вне SVG (решение: label ReferenceLine не рендерится в jsdom и недоступен
 * вспомогательным технологиям — HTML-подпись проверяема и читаема).
 */
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposedChart, Line } from 'recharts';

import type { ActiveScale } from '@hl/contracts';

import { referenceThresholdsOf, ReferenceLines } from './ReferenceLines';

/** Фикстура шкалы ESC/ESH 2018 (§20.1: категории high_normal 130/85, hypertension1 140/90). */
export const SCALE_FIXTURE: ActiveScale = {
  code: 'esc-esh-2018',
  version: '1.0.0',
  sourceLabel: 'ESC/ESH 2018',
  categories: [
    {
      code: 'optimal',
      label: 'Оптимальное',
      sysRange: { min: null, max: 119 },
      diaRange: { min: null, max: 79 },
    },
    {
      code: 'normal',
      label: 'Нормальное',
      sysRange: { min: 120, max: 129 },
      diaRange: { min: 80, max: 84 },
    },
    {
      code: 'high_normal',
      label: 'Высокое нормальное',
      sysRange: { min: 130, max: 139 },
      diaRange: { min: 85, max: 89 },
    },
    {
      code: 'hypertension1',
      label: 'АГ 1 степени',
      sysRange: { min: 140, max: 159 },
      diaRange: { min: 90, max: 99 },
    },
    {
      code: 'hypertension2',
      label: 'АГ 2 степени',
      sysRange: { min: 160, max: 179 },
      diaRange: { min: 100, max: 109 },
    },
    {
      code: 'hypertension3',
      label: 'АГ 3 степени',
      sysRange: { min: 180, max: null },
      diaRange: { min: 110, max: null },
    },
  ],
  homeBPNote: '…',
  specialGroupsNote: '…',
};

afterEach(() => cleanup());

describe('referenceThresholdsOf — извлечение порогов из шкалы (§13: из данных, не хардкод)', () => {
  it('пороги high_normal и hypertension1: sys 130/140 (sysRange.min), dia 85/90 (diaRange.min)', () => {
    const result = referenceThresholdsOf(SCALE_FIXTURE);
    expect(result.sourceLabel).toBe('ESC/ESH 2018');
    expect(result.lines).toEqual([
      { channel: 'sys', value: 130 },
      { channel: 'sys', value: 140 },
      { channel: 'dia', value: 85 },
      { channel: 'dia', value: 90 },
    ]);
  });

  it('границы «открытой» стороны и отсутствующие категории пропускаются (min: null — не порог)', () => {
    const result = referenceThresholdsOf(SCALE_FIXTURE);
    // optimal (sysRange.min null) и hypertension3 (sysRange.max null — не граница) не дают линий.
    expect(result.lines.every((line) => Number.isFinite(line.value))).toBe(true);
    expect(result.lines).toHaveLength(4);
  });
});

describe('ReferenceLines — рендер внутри графика (§20.1: 4 опорные линии, 2 sys + 2 dia)', () => {
  it('4 линии .recharts-reference-line + HTML-подпись источника (один раз, §13)', () => {
    const { container, getByTestId, getByText } = render(
      createElement(
        ComposedChart,
        { width: 400, height: 200, data: [{ utcMs: 0, sys: 120 }] },
        createElement(Line, { dataKey: 'sys', isAnimationActive: false }),
        createElement(ReferenceLines, { scale: SCALE_FIXTURE }),
      ),
    );
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(4);
    expect(getByText('ESC/ESH 2018')).not.toBeNull();
    expect(getByTestId('scale-source')).not.toBeNull();
  });

  it('без шкалы линии и подпись не рендерятся (шкала ещё грузится — график уже виден)', () => {
    const { container, queryByTestId } = render(
      createElement(
        ComposedChart,
        { width: 400, height: 200, data: [{ utcMs: 0, sys: 120 }] },
        createElement(Line, { dataKey: 'sys', isAnimationActive: false }),
        createElement(ReferenceLines, { scale: undefined }),
      ),
    );
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(0);
    expect(queryByTestId('scale-source')).toBeNull();
  });
});
