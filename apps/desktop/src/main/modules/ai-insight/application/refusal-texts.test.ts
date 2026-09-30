// TASK-086 §19/§20: тесты refusalTextFactory — golden-снапшот четырёх отказ-текстов
// (__fixtures__/refusal-texts-golden.txt, байт-сравнение по прецеденту system-prompt),
// словарь-тест запрещённой лексики SRS 01 §8 (§14), treatment==dosage (один шаблон,
// §5), фактура — только числа (§13), номера по локали (§14), дефолты без meta
// (инъекция в ResponseGuard 085 — вызов с одним аргументом, §7 085).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PeriodStatisticsDto } from '@hl/contracts';

import type { RefusalClass } from '../domain/guardrail-policy.js';
import type { RefusalTextFactory as GuardRefusalTextFactory } from './response-guard.js';
import { REFUSAL_TEXT_KEYS, refusalText } from './refusal-texts.js';

/** ValueStats одной строкой (для DTO-литералов фикстур). */
function vs(avg: number | undefined): PeriodStatisticsDto['sys'] {
  return avg === undefined ? {} : { avg };
}

/**
 * Компактный PeriodStatisticsDto для мета фабрики (важны count/days/avg — фактура
 * §7; остальное — нейтральные значения согласованной структуры).
 */
function statsOf(
  count: number,
  days: number,
  sysAvg: number | undefined,
  diaAvg: number | undefined,
  pulseAvg?: number,
): PeriodStatisticsDto {
  return {
    count,
    sys: vs(sysAvg),
    dia: vs(diaAvg),
    ...(pulseAvg === undefined ? {} : { pulse: vs(pulseAvg) }),
    critical: { high: false, low: false },
    daysWithMeasurements: days,
    longestStreakDays: days,
    insufficientData: { tooFewMeasurements: count < 7, tooFewDays: days < 3 },
  };
}

/** Фикстура golden-снапшота: период с данными (12 измерений / 6 дней, с пульсом). */
const WITH_DATA: PeriodStatisticsDto = statsOf(12, 6, 144.6, 91.3, 71.5);

/** Фикстура «мало данных»: 3 измерения за 2 дня (порог kernel нарушен, §20). */
const FEW: PeriodStatisticsDto = statsOf(3, 2, 148, 95);

const RU = 'ru';

/** Золотой документ: секции `[ключ]\n<текст>`, разделённые пустой строкой (см. fixture). */
function goldenDoc(): string {
  const withData = { stats: WITH_DATA, locale: RU };
  const few = { stats: FEW, locale: RU };
  return [
    `[${REFUSAL_TEXT_KEYS.treatment} == ${REFUSAL_TEXT_KEYS.dosage}]`,
    refusalText('treatment', withData),
    '',
    `[${REFUSAL_TEXT_KEYS.diagnosis}]`,
    refusalText('diagnosis', withData),
    '',
    `[${REFUSAL_TEXT_KEYS.insufficientData}]`,
    refusalText('insufficientData', few),
    '',
    `[${REFUSAL_TEXT_KEYS.emergency}]`,
    refusalText('emergency', { locale: RU }),
    '',
  ].join('\n');
}

describe('golden-снапшот четырёх отказ-текстов (§19/§20 — байт-сравнение)', () => {
  it('тексты классов == __fixtures__/refusal-texts-golden.txt', () => {
    const golden = readFileSync(
      join(import.meta.dirname, '__fixtures__', 'refusal-texts-golden.txt'),
      'utf8',
    );
    expect(goldenDoc()).toBe(golden);
  });

  it('у каждого RefusalClass есть ключ-идентификатор для логов (§5/§18)', () => {
    const classes: readonly RefusalClass[] = [
      'diagnosis',
      'treatment',
      'dosage',
      'emergency',
      'insufficientData',
    ];
    for (const cls of classes) {
      expect(REFUSAL_TEXT_KEYS[cls]).toMatch(/^ai\.refusal\./);
    }
  });
});

describe('классы без фактуры — базовые тексты стабильны', () => {
  it('treatment без данных — без блока «Вот что видно» (§5: фактура, «если есть данные»)', () => {
    const text = refusalText('treatment', { locale: RU });
    expect(text).toBe(
      'Это вопрос о лекарствах, а я не могу советовать приём или изменение препаратов. Обсудите это с врачом.',
    );
    expect(text).not.toContain('Вот что видно');
  });

  it('diagnosis при пустом периоде — честное «в периоде пока нет измерений»', () => {
    const text = refusalText('diagnosis', {
      stats: statsOf(0, 0, undefined, undefined),
      locale: RU,
    });
    expect(text).toContain('в периоде пока нет измерений');
    expect(text).toContain('Обратитесь к врачу для оценки.');
  });

  it('insufficientData без stats — защитный текст без чисел (инъекция из 085: meta нет)', () => {
    expect(refusalText('insufficientData')).toBe('Данных пока мало — я не буду делать выводов.');
  });

  it('insufficientData при пустом периоде — «0 измерений за 0 дней», факты без средних', () => {
    const text = refusalText('insufficientData', {
      stats: statsOf(0, 0, undefined, undefined),
      locale: RU,
    });
    expect(text).toBe(
      'Данных пока мало (0 измерений за 0 дней) — я не буду делать выводов. Вот факты: измерений в периоде нет.',
    );
  });
});

describe('treatment == dosage — один шаблон (§5)', () => {
  it('с данными и без — тексты классов совпадают байт-в-байт', () => {
    expect(refusalText('treatment', { stats: WITH_DATA, locale: RU })).toBe(
      refusalText('dosage', { stats: WITH_DATA, locale: RU }),
    );
    expect(refusalText('treatment', { locale: RU })).toBe(refusalText('dosage', { locale: RU }));
  });
});

describe('фактура — только числа, без интерпретаций (§13)', () => {
  it('фактура содержит count/дни/средние/пульс и больше ничего оценочного', () => {
    const text = refusalText('diagnosis', { stats: WITH_DATA, locale: RU });
    expect(text).toContain(
      'Вот что видно в данных: 12 измерений за 6 дней, среднее СДА 144.6, ДДА 91.3, пульс 71.5.',
    );
  });

  it('пульс не измерен — факт «пульс» отсутствует (не выдумывается)', () => {
    const text = refusalText('treatment', { stats: statsOf(12, 6, 144.6, 91.3), locale: RU });
    expect(text).toContain('среднее СДА 144.6, ДДА 91.3.');
    expect(text).not.toContain('пульс');
  });

  it('множественные формы RU: 1 измерение за 1 день, 3 измерения за 2 дня', () => {
    expect(
      refusalText('insufficientData', { stats: statsOf(1, 1, 130, 85), locale: RU }),
    ).toContain('(1 измерение за 1 день)');
    expect(refusalText('insufficientData', { stats: FEW, locale: RU })).toContain(
      '(3 измерения за 2 дня)',
    );
  });
});

describe('emergency — полный текст FR-7.4, номера по локали (§14/§20)', () => {
  it('локаль по умолчанию ru: 103/112, порог ≥180/120, кризы-формулировки панели', () => {
    const text = refusalText('emergency');
    expect(text).toContain('Давление ≥180/120 может указывать на гипертонический криз.');
    expect(text).toContain('сильная головная боль');
    expect(text).toContain('Немедленно обратитесь за медицинской помощью.');
    expect(text).toContain('Экстренные службы: 103 (скорая), 112 (единый)');
    expect(text).not.toContain('911');
  });

  it('en-US → 911, без 103/112; неизвестная локаль → fallback-фраза панели', () => {
    expect(refusalText('emergency', { locale: 'en-US' })).toContain('911');
    expect(refusalText('emergency', { locale: 'en-US' })).not.toContain('103');
    expect(refusalText('emergency', { locale: 'fr-FR' })).toContain(
      'Номер местной службы экстренной помощи',
    );
  });
});

describe('словарь-тест запрещённой лексики SRS 01 §8 (§14/§20)', () => {
  /** Запрет-словарь SRS 01 §8 (как в golden-тесте панели 041). */
  const FORBIDDEN: readonly string[] = [
    'диагноз',
    'у вас гипертония',
    'гипертония у вас',
    'лечение',
    'показание',
    'назначение',
  ];

  /** Все четыре текста в обеих вариантах (с данными / без). */
  function allTexts(): readonly string[] {
    const classes: readonly RefusalClass[] = [
      'treatment',
      'dosage',
      'diagnosis',
      'insufficientData',
      'emergency',
    ];
    return [
      ...classes.map((cls) => refusalText(cls, { stats: WITH_DATA, locale: RU })),
      ...classes.map((cls) => refusalText(cls, { locale: RU })),
      ...classes.map((cls) => refusalText(cls, { locale: 'en-US' })),
    ];
  }

  for (const forbidden of FORBIDDEN) {
    it(`нет «${forbidden}» ни в одном отказ-тексте`, () => {
      for (const text of allTexts()) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
    });
  }

  it('тексты непусты и различимы по классам (якорные подстроки)', () => {
    expect(refusalText('treatment', { locale: RU })).toContain('Это вопрос о лекарствах');
    expect(refusalText('diagnosis', { locale: RU })).toContain('Я не определяю заболевания');
    expect(refusalText('insufficientData', { locale: RU })).toContain('Данных пока мало');
    expect(refusalText('emergency', { locale: RU })).toContain('гипертонический криз');
  });
});

describe('совместимость с ResponseGuard 085 (§7: инъекция фабрики)', () => {
  it('refusalText структурно удовлетворяет RefusalTextFactory 085 (вызов с одним аргументом)', () => {
    const factory: GuardRefusalTextFactory = refusalText;
    // Вызов ровно как делает ResponseGuard.check — без meta.
    expect(factory('treatment')).toBe(refusalText('treatment'));
  });
});
