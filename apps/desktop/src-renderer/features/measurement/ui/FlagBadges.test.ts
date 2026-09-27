/**
 * TASK-042 §19: юниты FlagBadges — бейджи рендерятся по DTO-фикстурам (high, low,
 * irregular, комбо high+irregular, без флагов); клик high/low-бейджа открывает
 * CriticalPanel (TASK-041) модально со значениями записи, «Понятно, скрыть» и
 * Esc закрывают; a11y-атрибуты: aria-label полный («Критическое значение: 190 на
 * 125. Что это значит?»), tooltip (title) дублирует aria-label, иконки-формы
 * различны (! / ↓ / ~) — дальтонизм (§20: не только цвет); axe без critical.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import '../../../i18n';
import { FlagBadges, FlagLegend } from './FlagBadges';

/** База фикстур — нормальная запись без флагов (critical-ключа нет, §13). */
const DTO: MeasurementDto = {
  id: 'm-1',
  profileId: 'seed-profile-0001',
  sys: 125,
  dia: 82,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  takenAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
  tzOffsetMin: 180,
  source: 'manual',
  createdAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
  updatedAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
};

const HIGH: MeasurementDto = { ...DTO, sys: 190, dia: 125, critical: 'high' };
const LOW: MeasurementDto = { ...DTO, sys: 85, dia: 55, critical: 'low' };
const IRREGULAR: MeasurementDto = { ...DTO, irregularPulse: true };
const HIGH_AND_IRREGULAR: MeasurementDto = { ...HIGH, irregularPulse: true };

function renderBadges(measurement: MeasurementDto): void {
  render(createElement(FlagBadges, { measurement }));
}

afterEach(() => {
  cleanup();
});

describe('FlagBadges — бейджи по DTO-фикстурам (§19)', () => {
  it('high: кнопка с иконкой ! и текстом «Критическое»; irregular-бейджа нет', () => {
    renderBadges(HIGH);

    const badge = screen.getByTestId('flag-critical');
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.textContent).toContain('Критическое');
    expect(screen.getByTestId('flag-icon-critical').textContent).toBe('!');
    expect(screen.queryByTestId('flag-irregular')).toBeNull();
  });

  it('low: кнопка с иконкой ↓ и текстом «Пониженное» (§13: high и low — оба показываются)', () => {
    renderBadges(LOW);

    const badge = screen.getByTestId('flag-critical');
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.textContent).toContain('Пониженное');
    expect(screen.getByTestId('flag-icon-critical').textContent).toBe('↓');
  });

  it('irregular: не-кнопка с иконкой ~ и текстом «Неровный пульс»; critical-бейджа нет (§5: tooltip, без панели)', () => {
    renderBadges(IRREGULAR);

    const badge = screen.getByTestId('flag-irregular');
    expect(badge.tagName).not.toBe('BUTTON');
    expect(badge.textContent).toContain('Неровный пульс');
    expect(screen.getByTestId('flag-icon-irregular').textContent).toBe('~');
    expect(screen.queryByTestId('flag-critical')).toBeNull();
  });

  it('комбо high+irregular: оба бейджа (§19)', () => {
    renderBadges(HIGH_AND_IRREGULAR);

    expect(screen.getByTestId('flag-critical')).toBeDefined();
    expect(screen.getByTestId('flag-irregular')).toBeDefined();
  });

  it('без флагов: бейджей нет — место не резервируется, скринридер молчит (§13)', () => {
    const { container } = render(createElement(FlagBadges, { measurement: DTO }));

    expect(screen.queryByTestId('flag-critical')).toBeNull();
    expect(screen.queryByTestId('flag-irregular')).toBeNull();
    expect(container.innerHTML).toBe('');
  });
});

describe('FlagBadges — a11y-атрибуты (§16/§20)', () => {
  it('high: aria-label полный «Критическое значение: 190 на 125. Что это значит?», title его дублирует', () => {
    renderBadges(HIGH);

    const badge = screen.getByTestId('flag-critical');
    expect(badge.getAttribute('aria-label')).toBe('Критическое значение: 190 на 125. Что это значит?');
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
  });

  it('low: aria-label полный «Пониженное значение: 85 на 55. Что это значит?», title его дублирует', () => {
    renderBadges(LOW);

    const badge = screen.getByTestId('flag-critical');
    expect(badge.getAttribute('aria-label')).toBe('Пониженное значение: 85 на 55. Что это значит?');
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
  });

  it('irregular: aria-label объясняющий «Неровный пульс: измерение может быть неточным» (EC-10, §5)', () => {
    renderBadges(IRREGULAR);

    const badge = screen.getByTestId('flag-irregular');
    expect(badge.getAttribute('aria-label')).toBe('Неровный пульс: измерение может быть неточным');
    expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
  });

  it('иконки различимы без цвета: формы ! / ↓ / ~ попарно различны (§20)', () => {
    const icons: string[] = [];
    renderBadges(HIGH);
    icons.push(screen.getByTestId('flag-icon-critical').textContent ?? '');
    cleanup();
    renderBadges(LOW);
    icons.push(screen.getByTestId('flag-icon-critical').textContent ?? '');
    cleanup();
    renderBadges(IRREGULAR);
    icons.push(screen.getByTestId('flag-icon-irregular').textContent ?? '');

    expect(new Set(icons).size).toBe(3);
    expect(icons).toEqual(['!', '↓', '~']);
  });
});

describe('FlagBadges — клик бейджа открывает CriticalPanel (§10/§19)', () => {
  it('high: панель TASK-041 со значениями записи 190/125 и полным текстом FR-7.4', async () => {
    const user = userEvent.setup();
    renderBadges(HIGH);

    await user.click(screen.getByTestId('flag-critical'));

    const panel = await screen.findByTestId('critical-panel');
    expect(panel.textContent).toContain('Давление 190/125 может указывать на гипертонический криз.');
    expect(panel.textContent).toContain('Немедленно обратитесь за медицинской помощью.');
  });

  it('low: мягкая low-панель со значениями записи 85/55', async () => {
    const user = userEvent.setup();
    renderBadges(LOW);

    await user.click(screen.getByTestId('flag-critical'));

    const panel = await screen.findByTestId('critical-panel');
    expect(panel.textContent).toContain('Давление 85/55 ниже типичных значений.');
    expect(panel.textContent).not.toContain('103');
  });

  it('«Понятно, скрыть» закрывает панель (dismiss — §10)', async () => {
    const user = userEvent.setup();
    renderBadges(HIGH);
    await user.click(screen.getByTestId('flag-critical'));
    await screen.findByTestId('critical-panel');

    await user.click(screen.getByTestId('critical-panel-dismiss'));

    expect(screen.queryByTestId('critical-panel')).toBeNull();
  });

  it('Esc закрывает модальность (§10: привычка Esc — панель не блокирует работу)', async () => {
    const user = userEvent.setup();
    renderBadges(HIGH);
    await user.click(screen.getByTestId('flag-critical'));
    await screen.findByTestId('critical-panel');

    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('critical-panel')).toBeNull();
  });

  it('диалог с доступным именем из заголовка (§16: aria-labelledby Radix)', async () => {
    const user = userEvent.setup();
    renderBadges(HIGH);
    await user.click(screen.getByTestId('flag-critical'));
    await screen.findByTestId('critical-panel');

    expect(screen.getByRole('dialog', { name: 'Критическое значение записи' })).toBeDefined();
  });

  it('axe при открытой панели: violations с impact=critical отсутствуют (§16, прецедент TASK-032)', async () => {
    const user = userEvent.setup();
    renderBadges(HIGH);
    await user.click(screen.getByTestId('flag-critical'));
    await screen.findByTestId('critical-panel');

    const results = await axe.run(document.body);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});

describe('FlagLegend — легенда флагов (§5: tooltip-обучающая строка над списком)', () => {
  it('рендерит строку-легенду; tooltip (title) дублирует расшифровку (§16)', () => {
    render(createElement(FlagLegend));

    const legend = screen.getByTestId('flag-legend');
    expect(legend.textContent).toBe(
      'Отметки записей: ! критическое · ↓ пониженное · ~ неровный пульс',
    );
    expect(legend.getAttribute('title')).toBe(
      '«!» — критическое значение: нажмите на отметку, чтобы прочитать, что это значит; «↓» — пониженное значение; «~» — неровный пульс: измерение может быть неточным.',
    );
  });
});
