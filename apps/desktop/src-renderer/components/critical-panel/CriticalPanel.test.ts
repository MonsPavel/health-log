/**
 * TASK-041 §19: юниты CriticalPanel — golden-тест текста против SRS 04 FR-7.4
 * (дословные строки: «гипертонический криз», список симптомов, «немедленно
 * обратитесь за медицинской помощью», номера «103 (скорая), 112 (единый)»);
 * verbatim-интро без значений («Давление ≥180/120…»); low-вариант (мягкий, без
 * номеров и паники); запрет-тест лексики SRS 01 §8 («диагноз», «лечение»,
 * «у вас гипертония», «показание», «назначение») и отсутствие императивов
 * паники («срочно» — §22: есть конкретный шаг); dismiss → onDismiss; a11y:
 * role="alert" для high, aria-live="polite" для low, dismiss в фокус-порядке,
 * axe без critical; локаль интерфейса ведёт номера: en-US → 911 (§20).
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import '../../i18n';
import { CriticalPanel } from './CriticalPanel';

/** Текст панели (textContent корня) — для golden-проверок. */
function panelText(): string {
  return screen.getByTestId('critical-panel').textContent ?? '';
}

function renderHigh(sys?: number, dia?: number): void {
  render(createElement(CriticalPanel, { flag: 'high', onDismiss: () => undefined, sys, dia }));
}

function renderLow(sys?: number, dia?: number): void {
  render(createElement(CriticalPanel, { flag: 'low', onDismiss: () => undefined, sys, dia }));
}

afterEach(() => {
  cleanup();
  // Локаль-тесты меняют язык глобального i18n — возвращаем источник истины (§17).
  void i18n.changeLanguage('ru');
});

describe('CriticalPanel — high: golden-строки SRS FR-7.4 (§6/§13/§19)', () => {
  it('со значениями 190/125: интро, симптомы, призыв, номера — обязательные фразы', () => {
    renderHigh(190, 125);
    const text = panelText();

    expect(text).toContain('Давление 190/125 может указывать на гипертонический криз.');
    // Список симптомов — дословно SRS (§5): четыре пункта.
    expect(text).toContain('сильная головная боль');
    expect(text).toContain('боль в груди');
    expect(text).toContain('одышка');
    expect(text).toContain('нарушение речи или зрения');
    // Призыв — дословно SRS.
    expect(text).toContain('Немедленно обратитесь за медицинской помощью.');
    // Номера по локали RU (§5): «103 (скорая), 112 (единый)».
    expect(text).toContain('103 (скорая), 112 (единый)');
    // 911 в ru-локали не показывается.
    expect(text).not.toContain('911');
  });

  it('без значений — verbatim-интро SRS с порогом: «Давление ≥180/120 может указывать…»', () => {
    renderHigh();
    expect(panelText()).toContain('Давление ≥180/120 может указывать на гипертонический криз.');
  });

  it('симптомы — маркированный список из четырёх пунктов (§5 «список симптомов»)', () => {
    renderHigh(190, 125);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toEqual([
      'сильная головная боль',
      'боль в груди',
      'одышка',
      'нарушение речи или зрения',
    ]);
  });
});

describe('CriticalPanel — low: мягкий вариант (§5/§20 AC-6.2-дух)', () => {
  it('85/55: текст без паники — слабость/головокружение, обсудите с врачом', () => {
    renderLow(85, 55);
    const text = panelText();

    expect(text).toContain('Давление 85/55 ниже типичных значений.');
    expect(text).toContain('При слабости или головокружении обсудите это с врачом.');
    // Без паники high-варианта: ни криза, ни призыва, ни номеров служб.
    expect(text).not.toContain('криз');
    expect(text).not.toContain('Немедленно');
    expect(text).not.toContain('103');
  });

  it('без значений — порог low: «Давление ≤90/60 ниже типичных значений»', () => {
    renderLow();
    expect(panelText()).toContain('Давление ≤90/60 ниже типичных значений.');
  });
});

describe('CriticalPanel — запрет-тест лексики (§14, SRS 01 §8)', () => {
  it('high: нет «диагноз», «лечение», «гипертония у вас», «показание», «назначение»', () => {
    renderHigh(200, 130);
    const text = (panelText() ?? '').toLowerCase();
    for (const forbidden of [
      'диагноз',
      'лечение',
      'гипертония у вас',
      'у вас гипертония',
      'показание',
      'назначение',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('low: тот же запрет (§14)', () => {
    renderLow(85, 55);
    const text = (panelText() ?? '').toLowerCase();
    expect(text).not.toContain('диагноз');
    expect(text).not.toContain('лечение');
  });

  it('тон: нет императивов паники «срочно» — есть конкретный шаг (§22)', () => {
    renderHigh(190, 125);
    expect((panelText() ?? '').toLowerCase()).not.toContain('срочно');
  });
});

describe('CriticalPanel — dismiss (§5/§10/§19)', () => {
  it('кнопка «Понятно, скрыть» → onDismiss один раз (решение о скрытии — у владельца)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(createElement(CriticalPanel, { flag: 'high', onDismiss, sys: 190, dia: 125 }));

    await user.click(screen.getByTestId('critical-panel-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('кнопка доступна и в low-варианте (§10)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(createElement(CriticalPanel, { flag: 'low', onDismiss, sys: 85, dia: 55 }));

    await user.click(screen.getByRole('button', { name: 'Понятно, скрыть' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('CriticalPanel — доступность (§16/§20)', () => {
  it('high: role="alert" на корне панели (озвучить сразу)', () => {
    renderHigh(190, 125);
    const panel = screen.getByTestId('critical-panel');
    expect(panel.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('alert')).toBe(panel);
  });

  it('low: aria-live="polite" (§16), role="alert" нет', () => {
    renderLow(85, 55);
    const panel = screen.getByTestId('critical-panel');
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(panel.getAttribute('role')).toBeNull();
  });

  it('dismiss-кнопка в фокус-порядке: первый Tab ведёт к ней (§16)', async () => {
    const user = userEvent.setup();
    renderHigh(190, 125);

    await user.tab();

    expect(document.activeElement).toBe(screen.getByTestId('critical-panel-dismiss'));
  });

  it('axe high: violations с impact=critical отсутствуют (§16, прецедент TASK-032)', async () => {
    renderHigh(190, 125);

    const results = await axe.run(document.body);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });

  it('axe low: violations с impact=critical отсутствуют (§16)', async () => {
    renderLow(85, 55);

    const results = await axe.run(document.body);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});

describe('CriticalPanel — номера по локали интерфейса (§17/§20)', () => {
  it('локаль en-US → «911», без 103/112 (тестовый стенд каталога, §20)', async () => {
    await i18n.changeLanguage('en-US');
    renderHigh(190, 125);
    const text = panelText();

    expect(text).toContain('911');
    expect(text).not.toContain('103');
    expect(text).not.toContain('112');
  });

  it('неизвестная локаль → fallback-фраза «Номер местной службы экстренной помощи» (§5/§20)', async () => {
    await i18n.changeLanguage('fr-FR');
    renderHigh(190, 125);
    const text = panelText();

    expect(text).toContain('Номер местной службы экстренной помощи');
    expect(text).not.toContain('103');
    expect(text).not.toContain('911');
  });
});
