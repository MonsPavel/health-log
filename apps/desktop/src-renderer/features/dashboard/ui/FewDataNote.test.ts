/**
 * TASK-060 §5/§13/§16/§17/§19: тесты пометки «мало данных» над графиком.
 *
 * Матрица (§19): RU-плюрализация «1 измерение / 2 измерения / 5 измерений»
 * (§17: ключ dashboard.fewData, params {count}, ICU-формы — прецедент
 * pulse.hiddenCount TASK-058); role="note" (§16 — статично, прецедент
 * TrendSummary 059); текст честности §3/EC-09: «Выводы будут точнее с
 * накоплением» — без выводов по малым данным.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { FewDataNote } from './FewDataNote';

import '../../../i18n';

afterEach(() => cleanup());

describe('FewDataNote — пометка «мало данных» (§5/§19)', () => {
  it('полоса с текстом «Мало данных — {N} … с накоплением», role="note" (§16)', () => {
    render(createElement(FewDataNote, { count: 3 }));

    const note = screen.getByTestId('few-data-note');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('Мало данных — 3 измерения за период');
    expect(note.textContent).toContain('Выводы будут точнее с накоплением');
  });

  it('(§19) RU-plural: 1 измерение / 2 измерения / 5 измерений', () => {
    render(createElement(FewDataNote, { count: 1 }));
    expect(screen.getByTestId('few-data-note').textContent).toContain(
      'Мало данных — 1 измерение за период',
    );
    cleanup();

    render(createElement(FewDataNote, { count: 2 }));
    expect(screen.getByTestId('few-data-note').textContent).toContain(
      'Мало данных — 2 измерения за период',
    );
    cleanup();

    render(createElement(FewDataNote, { count: 5 }));
    expect(screen.getByTestId('few-data-note').textContent).toContain(
      'Мало данных — 5 измерений за период',
    );
  });
});
