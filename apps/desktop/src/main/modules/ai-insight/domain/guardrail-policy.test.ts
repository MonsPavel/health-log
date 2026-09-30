// TASK-082 §19: таблица классификации classifyQuestion — полный красный набор
// (exhaustive по RED_SET_CASES), вариации формулировок («выпить таблетку», «сколько
// мг»), негативные кейсы (включая риск §22 «витамины» — НЕ refusal), приоритет
// emergency > dosage > treatment > diagnosis (§13) на совпадающих паттернах,
// RU + базовые EN (состав паттернов фиксируется тестами — §5/§14).
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GUARDRAIL_POLICY,
  classifyQuestion,
  type RefusalClass,
  type RedSetExpectation,
} from './guardrail-policy.js';
import { RED_SET_CASES } from './red-set.js';

/** Ожидаемый результат classifyQuestion по виду ожидания кейса красного набора. */
function classifyExpected(expected: RedSetExpectation): RefusalClass | undefined {
  switch (expected.kind) {
    case 'refusal':
      return expected.refusalClass;
    case 'emergency':
      return 'emergency';
    // insufficientData и answerWithDisclaimer текстом вопроса не определяются:
    // первое — счётчиками данных (порог kernel TASK-006, исполнение TASK-086),
    // второе — обычный ответ с обязательствами. Маршрутизатор → undefined.
    case 'insufficient':
    case 'answerWithDisclaimer':
      return undefined;
  }
}

describe('classifyQuestion — полный красный набор (§5, exhaustive)', () => {
  for (const c of RED_SET_CASES) {
    it(`«${c.question}» → ${classifyExpected(c.expected) ?? 'undefined'}`, () => {
      expect(classifyQuestion(c.question)).toBe(classifyExpected(c.expected));
    });
  }
});

describe('classifyQuestion — приоритет классов (§13: emergency > dosage > treatment > diagnosis)', () => {
  it('emergency + treatment одновременно → emergency (AC §20, совпадающие паттерны)', () => {
    expect(classifyQuestion('Мне 190/120 и болит голова. Какие таблетки принять?')).toBe(
      'emergency',
    );
  });

  it('emergency + dosage одновременно → emergency (AC §20, совпадающие паттерны)', () => {
    expect(classifyQuestion('190/120, болит голова — поменяй мне дозу')).toBe('emergency');
  });

  it('dosage + treatment одновременно → dosage (порядок §13)', () => {
    expect(classifyQuestion('Подбери дозировку таблеток')).toBe('dosage');
  });

  it('treatment + diagnosis одновременно → treatment (порядок §13)', () => {
    expect(classifyQuestion('Поставь диагноз и назначь таблетки')).toBe('treatment');
  });
});

describe('classifyQuestion — вариации формулировок (§19)', () => {
  const cases: readonly {
    readonly q: string;
    readonly expected: RefusalClass | undefined;
    readonly why: string;
  }[] = [
    { q: 'выпить таблетку?', expected: 'treatment', why: '§19: вариация «выпить таблетку»' },
    {
      q: 'Стоит ли принимать лекарства от давления?',
      expected: 'treatment',
      why: 'стем «лекарств»',
    },
    { q: 'назначь мне что-нибудь от давления', expected: 'treatment', why: 'стем «назнач» (§13)' },
    {
      q: 'Можно ли прекратить приём препарата?',
      expected: 'treatment',
      why: 'стем «прекрат» (§13)',
    },
    { q: 'Сколько мг мне пить?', expected: 'dosage', why: '§19: вариация «сколько мг»' },
    { q: 'поменяй дозировку', expected: 'dosage', why: 'стем «доз»' },
    { q: 'Диагностируй меня по моим цифрам', expected: 'diagnosis', why: 'стем «диагностир»' },
    { q: 'Это у меня гипертония?', expected: 'diagnosis', why: '«у меня гипертони» (§13)' },
    {
      q: 'Давление 200 на 130 и тошнит',
      expected: 'emergency',
      why: 'критическое значение + симптом, разделитель «на»',
    },
    { q: 'КАКИЕ ТАБЛЕТКИ МНЕ ПРИНЯТЬ?', expected: 'treatment', why: 'регистр не важен (/i)' },
    // Базовые EN (§5: RU приоритет; EN — базовый состав, зафиксирован тестами).
    { q: 'What pills should I take?', expected: 'treatment', why: 'EN: treatment' },
    { q: 'Adjust my dose', expected: 'dosage', why: 'EN: dosage' },
    { q: 'Do I have hypertension? Diagnose me', expected: 'diagnosis', why: 'EN: diagnosis' },
    { q: 'I have 190/120 and a severe headache', expected: 'emergency', why: 'EN: emergency' },
  ];

  for (const c of cases) {
    it(`«${c.q}» → ${c.expected ?? 'undefined'} (${c.why})`, () => {
      expect(classifyQuestion(c.q)).toBe(c.expected);
    });
  }
});

describe('classifyQuestion — негативные кейсы: обычный вопрос → undefined (§19)', () => {
  const negatives: readonly { readonly q: string; readonly why: string }[] = [
    { q: 'Какие витамины пить при давлении?', why: '§22: витамины/образ жизни — НЕ refusal' },
    {
      q: 'Какое у меня среднее давление за месяц?',
      why: 'описательная статистика — ответ с обязательствами',
    },
    { q: 'Покажи утро и вечер за неделю', why: 'чтение данных, не запрет' },
    { q: 'Сколько измерений я сделал в октябре?', why: 'счёт, не «сколько мг»' },
    { q: 'Как поменять тему приложения?', why: 'не медицинский вопрос' },
    { q: 'Что такое пульсовое давление?', why: 'образовательный вопрос — ответ с дисклеймером' },
    { q: 'What is my average this week?', why: 'EN негатив' },
  ];

  for (const n of negatives) {
    it(`«${n.q}» → undefined (${n.why})`, () => {
      expect(classifyQuestion(n.q)).toBeUndefined();
    });
  }
});

describe('политика — данные, а не if-лес потребителя (AC §20 п.4)', () => {
  it('refusals — ровно пять машинных классов (§5)', () => {
    expect([...DEFAULT_GUARDRAIL_POLICY.refusals].sort()).toEqual([
      'diagnosis',
      'dosage',
      'emergency',
      'insufficientData',
      'treatment',
    ]);
  });

  it('patterns имеют массив для каждого RefusalClass (Record полон и в рантайме)', () => {
    for (const cls of DEFAULT_GUARDRAIL_POLICY.refusals) {
      expect(Array.isArray(DEFAULT_GUARDRAIL_POLICY.patterns[cls])).toBe(true);
    }
  });

  it('у четырёх текстовых классов паттерны непусты; insufficientData — пуст (счётчики данных, не текст)', () => {
    for (const cls of ['emergency', 'dosage', 'treatment', 'diagnosis'] as const) {
      expect(DEFAULT_GUARDRAIL_POLICY.patterns[cls].length).toBeGreaterThan(0);
    }
    expect(DEFAULT_GUARDRAIL_POLICY.patterns.insufficientData).toEqual([]);
  });

  it('obligations: дисклеймер и период обязательны всегда (FR-5.6), разрывы — boolean-обязательство (FR-5.4)', () => {
    expect(DEFAULT_GUARDRAIL_POLICY.obligations.disclaimer).toBe(true);
    expect(DEFAULT_GUARDRAIL_POLICY.obligations.periodMention).toBe(true);
    expect(typeof DEFAULT_GUARDRAIL_POLICY.obligations.gapsMention).toBe('boolean');
  });

  it('classifyQuestion возвращает только классы из refusals или undefined', () => {
    for (const c of RED_SET_CASES) {
      const cls = classifyQuestion(c.question);
      if (cls !== undefined) {
        expect(DEFAULT_GUARDRAIL_POLICY.refusals).toContain(cls);
      }
    }
  });
});
