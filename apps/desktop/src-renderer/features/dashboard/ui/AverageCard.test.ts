/**
 * TASK-061 §5/§13/§19: тесты карточки «Среднее за 7 дней» домашней сводки.
 *
 * ДАННЫЕ (§4/§5 — принцип задачи): карточка собирается из ГОТОВОГО stats-ответа
 * (stats/period 7d) — никаких новых вычислений; числа — фикстура канала (§20 AC2).
 * Категория+notes — из classification того же ответа; подпись категории —
 * ИЗ ДАННЫХ шкалы (scales/active, R-1: формулировки не хардкодятся).
 *
 * МАЛО ДАННЫХ (§13, AC3): флаг insufficientData → пометка «мало данных»
 * TASK-060-стиля (компонент FewDataNote переиспользуется), категория ОТСУТСТВУЕТ
 * (классификатор вернул undefined — EC-09, UI не может наврать); note классифи-
 * кации kind=insufficientData не дублирует пометку (та же мысль другим текстом —
 * в карточке она одна).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PeriodStatisticsDto } from '@hl/contracts';

import { AverageCard } from './AverageCard';

import '../../../i18n';

afterEach(() => cleanup());

/**
 * Категория классификации — полный SCALE_CATEGORY-объект (§7 054): подпись едет
 * В stats-ответе из данных шкалы (R-1, классификация без второй загрузки).
 */
const CATEGORY_NORMAL = {
  code: 'normal' as const,
  label: 'Нормальное',
  sysRange: { min: 120, max: 129 },
  diaRange: { min: 80, max: 84 },
};

/** stats 7d с классификацией (достаточно данных — §20 AC2). */
const STATS_7D: PeriodStatisticsDto = {
  count: 12,
  sys: { avg: 124.3, min: 110, max: 140 },
  dia: { avg: 79.5, min: 70, max: 88 },
  pulse: { avg: 66.25 },
  critical: { high: false, low: false },
  daysWithMeasurements: 10,
  longestStreakDays: 6,
  insufficientData: { tooFewMeasurements: false, tooFewDays: false },
  classification: {
    category: CATEGORY_NORMAL,
    notes: [
      { kind: 'homeBP', text: 'Классификация для домашних измерений давления' },
      { kind: 'specialGroups', text: 'При диабете пороги другие — см. заметки врача' },
    ],
  },
};

/** stats 7d «мало данных»: 3 записи, классификатор вернул undefined-категорию (EC-09). */
const STATS_7D_FEW: PeriodStatisticsDto = {
  count: 3,
  sys: { avg: 122, min: 118, max: 128 },
  dia: { avg: 80, min: 76, max: 82 },
  critical: { high: false, low: false },
  daysWithMeasurements: 3,
  longestStreakDays: 3,
  insufficientData: { tooFewMeasurements: true, tooFewDays: true },
  classification: {
    notes: [
      {
        kind: 'insufficientData',
        text: 'Данных пока мало: среднее и категория за период не определяются — продолжайте измерения.',
      },
    ],
  },
};

describe('AverageCard — средние 7 дней из stats-канала (§5/§20 AC2)', () => {
  it('СДА/ДДА/ЧСС и count — числа фикстуры stats (ru-формат дробных)', () => {
    render(createElement(AverageCard, { stats: STATS_7D }));

    expect(screen.getByTestId('average-sys').textContent).toBe('СДА 124,3');
    expect(screen.getByTestId('average-dia').textContent).toBe('ДДА 79,5');
    expect(screen.getByTestId('average-pulse').textContent).toBe('ЧСС 66,3 уд/мин');
    expect(screen.getByTestId('average-count').textContent).toBe('Измерений: 12');
  });

  it('категория — подпись ИЗ classification (label едет в stats-ответе, R-1); notes — тексты classification', () => {
    render(createElement(AverageCard, { stats: STATS_7D }));

    expect(screen.getByTestId('average-category').textContent).toBe('Категория: Нормальное');
    const notes = screen.getByTestId('average-notes');
    expect(notes.textContent).toContain('Классификация для домашних измерений давления');
    expect(notes.textContent).toContain('При диабете пороги другие — см. заметки врача');
  });

  it('пульса в периоде нет (pulse отсутствует) — строка ЧСС не рендерится (честно)', () => {
    render(createElement(AverageCard, { stats: { ...STATS_7D, pulse: undefined } }));

    expect(screen.queryByTestId('average-pulse')).toBeNull();
    expect(screen.getByTestId('average-sys')).not.toBeNull();
  });

  it('секция с h3 «Среднее за 7 дней» (§16 иерархия заголовков)', () => {
    render(createElement(AverageCard, { stats: STATS_7D }));

    expect(screen.getByTestId('average-card').querySelector('h3')?.textContent).toBe(
      'Среднее за 7 дней',
    );
  });
});

describe('AverageCard — мало данных (§13/§20 AC3)', () => {
  it('(AC3) insufficientData → пометка «Мало данных — 3 …» (FewDataNote), категория отсутствует', () => {
    render(createElement(AverageCard, { stats: STATS_7D_FEW }));

    const note = screen.getByTestId('few-data-note');
    expect(note.textContent).toContain('Мало данных — 3 измерения за период');
    expect(screen.queryByTestId('average-category')).toBeNull();
    // Средние при 3 записях существуют и показываются (пометка — не сокрытие данных).
    expect(screen.getByTestId('average-sys').textContent).toBe('СДА 122');
    expect(screen.getByTestId('average-count').textContent).toBe('Измерений: 3');
  });

  it('note классификации kind=insufficientData не дублирует пометку («мало данных» в карточке одно)', () => {
    render(createElement(AverageCard, { stats: STATS_7D_FEW }));

    expect(screen.queryByTestId('average-notes')).toBeNull();
    expect(screen.getByTestId('average-card').textContent).not.toContain(
      'Данных пока мало: среднее и категория',
    );
  });

  it('без classification вовсе — ни категории, ни notes (честно; поля optional контракта)', () => {
    render(
      createElement(AverageCard, {
        stats: { ...STATS_7D, classification: undefined },
      }),
    );

    expect(screen.queryByTestId('average-category')).toBeNull();
    expect(screen.queryByTestId('average-notes')).toBeNull();
    // Средние и count от классификации не зависят.
    expect(screen.getByTestId('average-sys')).not.toBeNull();
    expect(screen.getByTestId('average-count')).not.toBeNull();
  });
});
