/**
 * TASK-059 §5/§13/§16/§19: тесты текстового резюме тренда под графиком.
 *
 * Матрица (§20 AC3): «Среднее СДА за 30 дней: 128 (диапазон 112–145)» — числа
 * РАВНЫ stats-ответу (сверка строк на фикстуре; единственный источник — read
 * model stats/period, §13: «резюме-числа == числа таблицы == числа графика»);
 * role="note" статично (§16 — решение против aria-live); дробные — ru-формат
 * (правило отображения 052); пустые каналы (avg отсутствует — период без записей
 * или нет пульса) — строка не рендерится, count остаётся.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PeriodStatisticsDto } from '@hl/contracts';

import { formatNumberRu, TrendSummary } from './TrendSummary';

import '../../../i18n';

afterEach(() => cleanup());

/** Полная фикстура статистики (§20 AC3: «128 (диапазон 112–145)»). */
const STATS: PeriodStatisticsDto = {
  count: 90,
  sys: { avg: 128, min: 112, max: 145, sd: 9 },
  dia: { avg: 82, min: 76, max: 90 },
  critical: { high: false, low: false },
  daysWithMeasurements: 30,
  longestStreakDays: 30,
  insufficientData: { tooFewMeasurements: false, tooFewDays: false },
};

describe('TrendSummary — резюме из stats-ответа (§5/§13/§20 AC3)', () => {
  it('(AC3) строки «Среднее СДА/ДДА за {{period}}: avg (диапазон min–max)» + «Измерений» — числа равны stats', () => {
    render(createElement(TrendSummary, { stats: STATS, periodLabel: '30 дней' }));

    const summary = screen.getByTestId('trend-summary');
    expect(summary.getAttribute('role')).toBe('note');
    expect(summary.textContent).toContain('Среднее СДА за 30 дней: 128 (диапазон 112–145)');
    expect(summary.textContent).toContain('Среднее ДДА за 30 дней: 82 (диапазон 76–90)');
    expect(summary.textContent).toContain('Измерений: 90');
  });

  it('дробное среднее — ru-формат Intl (максимум 1 знак — правило отображения 052)', () => {
    render(
      createElement(TrendSummary, {
        stats: { ...STATS, sys: { avg: 124.6, min: 112, max: 145 } },
        periodLabel: '7 дней',
      }),
    );
    expect(screen.getByTestId('trend-summary').textContent).toContain(
      'Среднее СДА за 7 дней: 124,6 (диапазон 112–145)',
    );
  });

  it('канал без агрегатов (avg отсутствует) — строки канала нет; count остаётся (пустой период — честно)', () => {
    render(
      createElement(TrendSummary, {
        stats: { ...STATS, count: 0, sys: {}, dia: {} },
        periodLabel: '30 дней',
      }),
    );
    const text = screen.getByTestId('trend-summary').textContent ?? '';
    expect(text).not.toContain('Среднее СДА');
    expect(text).not.toContain('Среднее ДДА');
    expect(text).toContain('Измерений: 0');
  });
});

describe('formatNumberRu — единый формат чисел резюме (aria-метка графика = те же числа)', () => {
  it('целые без дробной части; дробные — запятая и максимум 1 знак (Intl ru-RU)', () => {
    expect(formatNumberRu(128)).toBe('128');
    expect(formatNumberRu(124.55)).toBe('124,6');
    expect(formatNumberRu(82)).toBe('82');
  });
});
