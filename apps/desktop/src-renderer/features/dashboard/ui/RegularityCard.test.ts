/**
 * TASK-061 §13/§16/§17/§19: тесты карточки «Регулярность» домашней сводки.
 *
 * GOLDEN-тексты серии (§13 — дружелюбный тон FR-4.4, без вины): 0 дней →
 * «Начните сегодня — это просто»; 1 → «Серия: 1 день — отлично»; N →
 * «Серия: N дней» (5 дней — §2). Плюрализация RU — LDML-суффиксы каталога +
 * Intl.PluralRules (§17, прецедент FewDataNote 060). Вторая строка — «за 30
 * дней: N дня/дней с измерениями» (daysWithMeasurements stats 30d — §5).
 *
 * ДОСТУПНОСТЬ (§16): серия — НЕ «ошибка/успех» цветом: никакого role="alert"
 * в карточке нет (нейтральный акцент), тексты полные — скринридер читает
 * содержимое, не статус.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PeriodStatisticsDto } from '@hl/contracts';

import { RegularityCard } from './RegularityCard';

import '../../../i18n';

afterEach(() => cleanup());

/** Минимальный stats 30d: карточка регулярности читает только дни серии/периода. */
function stats30d(daysWithMeasurements: number, longestStreakDays: number): PeriodStatisticsDto {
  return {
    count: daysWithMeasurements * 2,
    sys: { avg: 124, min: 110, max: 140 },
    dia: { avg: 79, min: 70, max: 88 },
    critical: { high: false, low: false },
    daysWithMeasurements,
    longestStreakDays,
    insufficientData: { tooFewMeasurements: false, tooFewDays: false },
  };
}

describe('RegularityCard — golden-тексты серии (§13: 0/1/N дней)', () => {
  it('(§13) 0 дней → «Начните сегодня — это просто» (без вины)', () => {
    render(createElement(RegularityCard, { stats: stats30d(0, 0) }));

    expect(screen.getByTestId('regularity-streak').textContent).toBe(
      'Начните сегодня — это просто',
    );
  });

  it('(§13) 1 день → «Серия: 1 день — отлично»', () => {
    render(createElement(RegularityCard, { stats: stats30d(1, 1) }));

    expect(screen.getByTestId('regularity-streak').textContent).toBe('Серия: 1 день — отлично');
  });

  it('(§2/§13) 5 дней → «Серия: 5 дней»', () => {
    render(createElement(RegularityCard, { stats: stats30d(22, 5) }));

    expect(screen.getByTestId('regularity-streak').textContent).toBe('Серия: 5 дней');
  });

  it('(§17) 22 дня → «Серия: 22 дня» (few-форма ICU plural)', () => {
    render(createElement(RegularityCard, { stats: stats30d(22, 22) }));

    expect(screen.getByTestId('regularity-streak').textContent).toBe('Серия: 22 дня');
  });
});

describe('RegularityCard — дни с измерениями за 30 дней (§5: из stats 30d)', () => {
  it('22 дня → «за 30 дней: 22 дня с измерениями»', () => {
    render(createElement(RegularityCard, { stats: stats30d(22, 5) }));

    expect(screen.getByTestId('regularity-days').textContent).toBe(
      'за 30 дней: 22 дня с измерениями',
    );
  });

  it('1 день → «за 30 дней: 1 день с измерениями» (one-форма)', () => {
    render(createElement(RegularityCard, { stats: stats30d(1, 1) }));

    expect(screen.getByTestId('regularity-days').textContent).toBe(
      'за 30 дней: 1 день с измерениями',
    );
  });

  it('0 дней → «за 30 дней: 0 дней с измерениями» (честно, many-форма)', () => {
    render(createElement(RegularityCard, { stats: stats30d(0, 0) }));

    expect(screen.getByTestId('regularity-days').textContent).toBe(
      'за 30 дней: 0 дней с измерениями',
    );
  });
});

describe('RegularityCard — структура (§16: секция/заголовок, нейтральный тон)', () => {
  it('секция с h3 «Регулярность»; серия — не alert/статус (нейтральный акцент §16)', () => {
    render(createElement(RegularityCard, { stats: stats30d(22, 5) }));

    const card = screen.getByTestId('regularity-card');
    expect(card.querySelector('h3')?.textContent).toBe('Регулярность');
    // §16: серия — не «ошибка/успех»: никакого alert-региона в карточке нет.
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(card.querySelector('[role="status"]')).toBeNull();
  });
});
