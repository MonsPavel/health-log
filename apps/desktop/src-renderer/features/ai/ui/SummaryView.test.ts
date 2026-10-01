/**
 * TASK-088 §5/§10/§14/§16: представление резюме/стрима:
 *  - дисклеймер + «Период анализа» НЕСЪЁМНЫЕ (AC-5.2, §14): у компонента НЕТ пропа
 *    скрытия — матрица всех комбинаций пропов всегда рендерит футер (тест
 *    «отсутствия способа скрыть»);
 *  - отказ-ответ — серый блок с info-иконкой, различимый от обычного разбора (§10);
 *  - бейджи: «из кэша» (финал cache-hit) и стейлс (жёлтый, клик = перегенерация §10);
 *  - стрим: aria-live="polite", после финала — "off" (§16).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { SummaryView } from './SummaryView';

afterEach(cleanup);

const BASE = {
  text: 'Среднее СДА 124 — значения в целевой зоне.',
  disclaimerText: 'Это не медицинская консультация.',
  periodText: 'последние 30 дней',
};

/** Матрица комбинаций флагов (все допустимые состояния представления). */
const COMBINATIONS: ReadonlyArray<Record<string, boolean>> = [
  {},
  { streaming: true },
  { cached: true },
  { refusal: true },
  { stale: true },
  { streaming: true, cached: true },
  { refusal: true, stale: true },
];

describe('SummaryView — несъёмный футер дисклеймера и периода (AC-5.2, §14)', () => {
  it('при ЛЮБОЙ комбинации пропов футер с дисклеймером и периодом на месте', () => {
    for (const combination of COMBINATIONS) {
      render(createElement(SummaryView, { ...BASE, ...combination }));

      const footer = screen.getByTestId('insight-disclaimer');
      expect(footer.getAttribute('role')).toBe('note');
      expect(footer.textContent).toContain('Это не медицинская консультация.');
      expect(footer.textContent).toContain('последние 30 дней');

      cleanup();
    }
  });
});

describe('SummaryView — отказ-стиль, бейджи, aria-live (§5/§10/§16)', () => {
  it('отказ: серый блок (data-kind="refusal") с info-иконкой; у обычного разбора иконки нет', () => {
    const { rerender } = render(createElement(SummaryView, { ...BASE, refusal: true }));

    expect(screen.getByTestId('insight-summary-text').getAttribute('data-kind')).toBe('refusal');
    expect(screen.getByTestId('insight-refusal-icon')).toBeDefined();

    rerender(createElement(SummaryView, { ...BASE }));
    expect(screen.getByTestId('insight-summary-text').getAttribute('data-kind')).toBeNull();
    expect(screen.queryByTestId('insight-refusal-icon')).toBeNull();
  });

  it('финал из кэша: бейдж «из кэша» виден; без cache-hit — бейджа нет', () => {
    const { rerender } = render(createElement(SummaryView, { ...BASE, cached: true }));

    expect(screen.getByTestId('insight-cached-badge').textContent).toContain('из кэша');

    rerender(createElement(SummaryView, { ...BASE }));
    expect(screen.queryByTestId('insight-cached-badge')).toBeNull();
  });

  it('стейлс-бейдж: виден при stale, клик вызывает перегенерацию (§10)', () => {
    const onStaleClick = vi.fn();
    const { rerender } = render(createElement(SummaryView, { ...BASE, stale: true, onStaleClick }));

    const badge = screen.getByTestId('insight-stale-badge');
    expect(badge.textContent).toContain('Данные изменились');
    fireEvent.click(badge);
    expect(onStaleClick).toHaveBeenCalledTimes(1);

    // Актуальный разбор — бейджа нет (§12: stale=false после свежей генерации).
    rerender(createElement(SummaryView, { ...BASE, onStaleClick }));
    expect(screen.queryByTestId('insight-stale-badge')).toBeNull();
  });

  it('стрим: aria-live polite; финал — off (§16: живой текст, без спама после done)', () => {
    const { rerender } = render(createElement(SummaryView, { ...BASE, streaming: true }));
    expect(screen.getByTestId('insight-summary-text').getAttribute('aria-live')).toBe('polite');

    rerender(createElement(SummaryView, { ...BASE }));
    expect(screen.getByTestId('insight-summary-text').getAttribute('aria-live')).toBe('off');
  });
});
