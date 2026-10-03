/**
 * TASK-088 §5/§10/§14/§16: представление резюме/стрима:
 *  - дисклеймер + «Период анализа» НЕСЪЁМНЫЕ (AC-5.2, §14): у компонента НЕТ пропа
 *    скрытия — матрица всех комбинаций пропов всегда рендерит футер (тест
 *    «отсутствия способа скрыть»);
 *  - отказ-ответ — серый блок с info-иконкой, различимый от обычного разбора (§10);
 *  - бейджи: «из кэша» (финал cache-hit) и стейлс (жёлтый, клик = перегенерация §10);
 *  - стрим (TASK-109 §13): aria-live="off" + aria-busy — дельты НЕ озвучиваются
 *    («не буква-за-буквой»); финал — region снова polite, текст-узел
 *    перемонтирован: вставка в polite-регион = одно озвучивание целиком.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { SummaryView } from './SummaryView';

afterEach(cleanup);

const BASE = {
  text: 'Среднее СДА 124 — значения в целевой зоне.',
  disclaimerText: 'Это не является медицинской консультацией.',
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
      expect(footer.textContent).toContain('Это не является медицинской консультацией.');
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

  it('стрим (TASK-109 §13): aria-live off + aria-busy — дельты НЕ озвучиваются', () => {
    render(createElement(SummaryView, { ...BASE, streaming: true }));
    const container = screen.getByTestId('insight-summary-text');
    expect(container.getAttribute('aria-live')).toBe('off');
    expect(container.getAttribute('aria-busy')).toBe('true');
    // Внутренний текст-узел помечен фазой стрима.
    expect(container.querySelector('[data-phase="stream"]')).not.toBeNull();
  });

  it('финал (TASK-109 §13): region снова polite, текст-узел ПЕРЕМОНТИРОВАН — вставка в polite-регион озвучивается один раз, целиком', () => {
    const { rerender } = render(createElement(SummaryView, { ...BASE, streaming: true }));
    const before = screen.getByTestId('insight-summary-text').querySelector('[data-phase]');
    expect(before).not.toBeNull();

    rerender(createElement(SummaryView, { ...BASE }));
    const container = screen.getByTestId('insight-summary-text');
    expect(container.getAttribute('aria-live')).toBe('polite');
    expect(container.getAttribute('aria-busy')).toBeNull();
    const after = container.querySelector('[data-phase="final"]');
    expect(after).not.toBeNull();
    // Перемонтирование: узел финала — НЕ тот же, что узел стрима.
    expect(after).not.toBe(before);
  });

  it('сохранённый разбор (без стрима): aria-live polite с первого рендера — без объявлений при монтировании', () => {
    render(createElement(SummaryView, { ...BASE }));
    const container = screen.getByTestId('insight-summary-text');
    expect(container.getAttribute('aria-live')).toBe('polite');
    expect(container.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('[data-phase="final"]')).not.toBeNull();
  });
});
