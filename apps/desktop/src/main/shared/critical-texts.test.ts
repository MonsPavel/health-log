// TASK-086 §19/§20: сверка critical-texts с панелью 041 — «Emergency-текст == текст
// панели 041 (тест-сверка общих констант) + номера по локали». Каталог панели
// (src-renderer/components/critical/ru.json) и её реестр номеров
// (critical-panel/emergency-numbers.ts) импортируются/читаются НАПРЯМУЮ — расхождение
// констант main с панелью = падение теста (дублирование снято сверкой: renderer
// импортировать main/shared не может по зонам арх. 03 §4, см. шапку critical-texts.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CRITICAL_CTA,
  CRITICAL_HIGH_INTRO,
  CRITICAL_NUMBERS_FALLBACK,
  CRITICAL_NUMBERS_LEAD,
  CRITICAL_SYMPTOMS,
  CRITICAL_SYMPTOMS_LEAD,
  CRITICAL_THRESHOLD_HIGH,
  CRITICAL_UNIFIED_LABEL,
  EMERGENCY_NUMBERS,
  criticalHighText,
  emergencyNumbersText,
  getEmergencyNumbers,
  interpolate,
} from './critical-texts.js';
import {
  EMERGENCY_NUMBERS as PANEL_NUMBERS,
  getEmergencyNumbers as getPanelNumbers,
} from '../../../src-renderer/components/critical-panel/emergency-numbers.js';

/** Каталог панели 041 (§6: сверка с константами панели — источник текстов UI). */
const CATALOG = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../src-renderer/components/critical/ru.json'),
    'utf8',
  ),
) as {
  panel: {
    high: {
      intro: string;
      symptomsLead: string;
      symptomHeadache: string;
      symptomChestPain: string;
      symptomBreathlessness: string;
      symptomSpeechOrVision: string;
      cta: string;
      numbersLead: string;
    };
    thresholds: { high: string };
    numbers: { withUnified: string; unifiedLabel: string; single: string; fallback: string };
  };
};

describe('критический текст — константы == каталогу панели 041 (§20 тест-сверка)', () => {
  it('интро, ведение, CTA, ведение номеров — дословно ключам critical.panel.high.*', () => {
    expect(CRITICAL_HIGH_INTRO).toBe(CATALOG.panel.high.intro);
    expect(CRITICAL_SYMPTOMS_LEAD).toBe(CATALOG.panel.high.symptomsLead);
    expect(CRITICAL_CTA).toBe(CATALOG.panel.high.cta);
    expect(CRITICAL_NUMBERS_LEAD).toBe(CATALOG.panel.high.numbersLead);
  });

  it('четыре симптома — дословно пунктам списка панели, в порядке SRS FR-7.4', () => {
    expect(CRITICAL_SYMPTOMS).toEqual([
      CATALOG.panel.high.symptomHeadache,
      CATALOG.panel.high.symptomChestPain,
      CATALOG.panel.high.symptomBreathlessness,
      CATALOG.panel.high.symptomSpeechOrVision,
    ]);
  });

  it('порог и форматы номеров — дословно critical.panel.thresholds/numbers', () => {
    expect(CRITICAL_THRESHOLD_HIGH).toBe(CATALOG.panel.thresholds.high);
    expect(CRITICAL_UNIFIED_LABEL).toBe(CATALOG.panel.numbers.unifiedLabel);
    expect(CRITICAL_NUMBERS_FALLBACK).toBe(CATALOG.panel.numbers.fallback);
  });
});

describe('реестр номеров — тот же, что у панели 041 (§14: «из того же реестра локали»)', () => {
  it('EMERGENCY_NUMBERS равен реестру панели (deep-equal)', () => {
    expect(EMERGENCY_NUMBERS).toEqual(PANEL_NUMBERS);
  });

  it('поведение getEmergencyNumbers совпадает с панельным на всех проверенных локалях', () => {
    for (const locale of ['ru', 'ru-RU', 'en-US', 'en', 'fr-FR', 'de-DE']) {
      expect(getEmergencyNumbers(locale)).toEqual(getPanelNumbers(locale));
    }
  });

  it('ru → 103/112, en-US → 911 (§20: номера по локали)', () => {
    expect(getEmergencyNumbers('ru')).toEqual({
      locale: 'ru',
      primary: '103',
      unified: '112',
      label: 'скорая',
    });
    expect(getEmergencyNumbers('en-US')).toEqual({
      locale: 'en-US',
      primary: '911',
      label: 'Emergency services',
    });
  });
});

describe('сборка текста срочности criticalHighText — байт-равен панели 041 (§20)', () => {
  /** Строки high-варианта панели, собранные ИЗ КАТАЛОГА (как рендерит CriticalPanel). */
  function panelHighLines(pressure: string, locale: string): readonly string[] {
    const numbers = getPanelNumbers(locale);
    const numbersText =
      numbers === undefined
        ? CATALOG.panel.numbers.fallback
        : numbers.unified !== undefined
          ? interpolate(CATALOG.panel.numbers.withUnified, {
              primary: numbers.primary,
              primaryLabel: numbers.label,
              unified: numbers.unified,
              unifiedLabel: CATALOG.panel.numbers.unifiedLabel,
            })
          : interpolate(CATALOG.panel.numbers.single, { primary: numbers.primary });
    return [
      interpolate(CATALOG.panel.high.intro, { pressure }),
      CATALOG.panel.high.symptomsLead,
      ...[CATALOG.panel.high.symptomHeadache,
        CATALOG.panel.high.symptomChestPain,
        CATALOG.panel.high.symptomBreathlessness,
        CATALOG.panel.high.symptomSpeechOrVision,
      ].map((symptom) => `- ${symptom}`),
      CATALOG.panel.high.cta,
      `${CATALOG.panel.high.numbersLead} ${numbersText}`,
    ];
  }

  it('ru: построчно совпадает с панелью; полный текст — join строк панели', () => {
    const lines = panelHighLines('≥180/120', 'ru');
    expect(criticalHighText('≥180/120', 'ru')).toBe(lines.join('\n'));
  });

  it('en-US: номера «911», остальной текст — тот же (каталог RU — тестовый стенд 041)', () => {
    expect(criticalHighText('≥180/120', 'en-US')).toBe(panelHighLines('≥180/120', 'en-US').join('\n'));
    expect(criticalHighText('≥180/120', 'en-US')).toContain('911');
    expect(criticalHighText('≥180/120', 'en-US')).not.toContain('103');
  });

  it('неизвестная локаль: fallback-фраза панели вместо номеров (§5/§20 041)', () => {
    const text = criticalHighText('≥180/120', 'fr-FR');
    expect(text).toBe(panelHighLines('≥180/120', 'fr-FR').join('\n'));
    expect(text).toContain(`${CRITICAL_NUMBERS_LEAD} ${CRITICAL_NUMBERS_FALLBACK}`);
  });

  it('значения записи подставляются вместо порога (как {sys, dia} панели, §13 041)', () => {
    expect(criticalHighText('190/125', 'ru').split('\n')[0]).toBe(
      'Давление 190/125 может указывать на гипертонический криз.',
    );
  });
});

describe('вспомогательные функции (контракт сборки)', () => {
  it('interpolate подставляет {{param}}', () => {
    expect(interpolate('{{a}} и {{b}}', { a: '1', b: '2' })).toBe('1 и 2');
  });

  it('emergencyNumbersText: с единым номером, без него, без реестра (форматы панели)', () => {
    expect(emergencyNumbersText(getEmergencyNumbers('ru'))).toBe('103 (скорая), 112 (единый)');
    expect(emergencyNumbersText(getEmergencyNumbers('en-US'))).toBe('911');
    expect(emergencyNumbersText(undefined)).toBe(CRITICAL_NUMBERS_FALLBACK);
  });
});
