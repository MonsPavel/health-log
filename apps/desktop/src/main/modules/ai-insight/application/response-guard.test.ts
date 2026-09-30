// TASK-085 §19/§20: таблицы фикстур — все unsafe-ответы заменяются (ожидаемые
// правило+класс), все safe-ответы проходят (включая пересказ заметок с дозой —
// §13 ключевой негативный кейс); замена — полный текст отказа фабрики, не обрезка
// (снапшот); лог-событие guardrail.replace без текста ответа (PHI); regex-сбой →
// fail-safe замена (тест-мок бросающего паттерна); правила — данные (состав R1–R4).
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_GUARDRAIL_POLICY } from '../domain/guardrail-policy.js';
import { SAFE_ANSWERS } from './__fixtures__/safe-answers.js';
import { UNSAFE_ANSWERS } from './__fixtures__/unsafe-answers.js';
import {
  RESPONSE_GUARD_RULES,
  ResponseGuard,
  type GuardResult,
  type GuardRule,
  type RefusalTextFactory,
} from './response-guard.js';

/**
 * Фабрика отказов-двойник (§7 — интерфейсная зависимость 086): длинный
 * различимый текст — снапшот «замена — полный текст отказа, не обрезка» (AC §20 п.3).
 */
const TEST_REFUSAL_TEXT: RefusalTextFactory = (cls) =>
  `[REFUSAL:${cls}] Я не могу давать такие рекомендации: это не медицинская ` +
  'консультация. Пожалуйста, обсудите этот вопрос с врачом.';

/** Спай-логгер (§18): типизированный vi.fn (прецедент add-measurement.test.ts) — mock.calls типизирован. */
function spyLogger(): { info: ReturnType<typeof makeInfoFn> } {
  return { info: makeInfoFn() };
}

/** vi.fn с сигнатурой ResponseGuardLogger.info — структурно удовлетворяет порту. */
function makeInfoFn(): ReturnType<
  typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>
> {
  return vi.fn<(message: string, meta?: Record<string, unknown>) => void>();
}

/** Guard с двойник-фабрикой и спай-логгером (§7: подстановочные в тестах). */
function guardWith(logger: { info: ReturnType<typeof makeInfoFn> }): ResponseGuard {
  return new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT, logger });
}

/** Ветвь replace результата (§7) — для типизированного доступа к text/ruleId/refusalClass. */
type ReplaceResult = Extract<GuardResult, { action: 'replace' }>;

/** Сужение до replace-ветви: expect + возврат (защита доступа к text без сужения). */
function toReplace(result: GuardResult): ReplaceResult {
  expect(result.action).toBe('replace');
  return result as ReplaceResult;
}

describe('ResponseGuard — unsafe-фикстуры: все заменяются (таблица §19/§20 п.1)', () => {
  for (const f of UNSAFE_ANSWERS) {
    it(`«${f.id}» → replace ${f.expectedRuleId}/${f.expectedRefusalClass} (${f.why})`, () => {
      const result = guardWith(spyLogger()).check(f.text);
      expect(result).toEqual({
        action: 'replace',
        text: TEST_REFUSAL_TEXT(f.expectedRefusalClass),
        ruleId: f.expectedRuleId,
        refusalClass: f.expectedRefusalClass,
      });
    });
  }

  it('фикстур достаточно по §5: 10–15 unsafe', () => {
    expect(UNSAFE_ANSWERS.length).toBeGreaterThanOrEqual(10);
    expect(UNSAFE_ANSWERS.length).toBeLessThanOrEqual(15);
  });
});

describe('ResponseGuard — safe-фикстуры: все проходят (таблица §19/§20 п.2)', () => {
  for (const f of SAFE_ANSWERS) {
    it(`«${f.id}» → pass (${f.why})`, () => {
      const logger = spyLogger();
      expect(guardWith(logger).check(f.text)).toEqual({ action: 'pass' });
      expect(logger.info).not.toHaveBeenCalled();
    });
  }

  it('фикстур достаточно по §5: не меньше 10 safe', () => {
    expect(SAFE_ANSWERS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('ResponseGuard — граница §4/§19: пересказ заметок vs императив с дозой', () => {
  it('«Вы отмечали приём 5 мг» → pass (пересказ заметок, §13 ключевой негативный кейс)', () => {
    expect(guardWith(spyLogger()).check('Вы отмечали приём 5 мг.')).toEqual({ action: 'pass' });
  });

  it('«Врач назначил 5 мг» → pass (описание факта из заметок, §4)', () => {
    expect(guardWith(spyLogger()).check('Врач назначил 5 мг.')).toEqual({ action: 'pass' });
  });

  it('«Принимайте 5 мг» → replace/dosage (императив рядом с дозой, §4)', () => {
    const result = guardWith(spyLogger()).check('Принимайте 5 мг препарата утром.');
    expect(result).toEqual({
      action: 'replace',
      text: TEST_REFUSAL_TEXT('dosage'),
      ruleId: 'R2',
      refusalClass: 'dosage',
    });
  });

  it('«Вам нужно принимать … 10 мг …» → R4/treatment (инфинитив не в стеме R1 §5; AUX-контекста нет)', () => {
    // «принимай\w*» (§5) — стем повелительного наклонения: «принимать» им не
    // покрыт, AUX §13 («рекомендую|стоит принять|назначьте себе») в предложении
    // нет → R2 молчит; долженствование ловит R4 «вам нужно …» → treatment.
    expect(
      guardWith(spyLogger()).check('Вам нужно принимать препараты по схеме: 10 мг утром.'),
    ).toEqual({
      action: 'replace',
      text: TEST_REFUSAL_TEXT('treatment'),
      ruleId: 'R4',
      refusalClass: 'treatment',
    });
  });

  it('императив-контекст считается ПО ПРЕДЛОЖЕНИЮ: доза в одном, императив в другом → pass (§13)', () => {
    // Доза — пересказ заметок; императив «обсудите» отсутствует в R1/AUX, а
    // «принимайте» из соседнего предложения не переносится в предложение с дозой.
    expect(guardWith(spyLogger()).check('Врач назначил 5 мг. Обсудите с врачом режим.')).toEqual({
      action: 'pass',
    });
  });

  it('пустой ответ → pass (нечего проверять)', () => {
    expect(guardWith(spyLogger()).check('')).toEqual({ action: 'pass' });
  });
});

describe('RESPONSE_GUARD_RULES — правила данные, не if-лес (§5)', () => {
  it('стартовый состав — ровно четыре правила R1–R4, id уникальны (§5)', () => {
    expect([...RESPONSE_GUARD_RULES.map((r) => r.id)].sort()).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(new Set(RESPONSE_GUARD_RULES.map((r) => r.id)).size).toBe(RESPONSE_GUARD_RULES.length);
  });

  it('каждое правило: action replace, класс из политики 082, непустой noteKey', () => {
    for (const rule of RESPONSE_GUARD_RULES) {
      expect(rule.action).toBe('replace');
      expect(DEFAULT_GUARDRAIL_POLICY.refusals).toContain(rule.refusalClass);
      expect(rule.noteKey.length).toBeGreaterThan(0);
    }
  });

  it('классы правил: R1/R4 → treatment, R2 → dosage, R3 → diagnosis (§5)', () => {
    const byId = new Map(RESPONSE_GUARD_RULES.map((r) => [r.id, r] as const));
    expect(byId.get('R1')?.refusalClass).toBe('treatment');
    expect(byId.get('R2')?.refusalClass).toBe('dosage');
    expect(byId.get('R3')?.refusalClass).toBe('diagnosis');
    expect(byId.get('R4')?.refusalClass).toBe('treatment');
  });

  it('только R2 — условное правило (императив-контекст в предложении, §13)', () => {
    const conditional = RESPONSE_GUARD_RULES.filter((r) => r.requireImperativeContext === true);
    expect(conditional.map((r) => r.id)).toEqual(['R2']);
  });

  it('паттерны без флага g — stateful .test (конвенция 082 §4)', () => {
    for (const rule of RESPONSE_GUARD_RULES) {
      expect(rule.pattern.flags).not.toContain('g');
    }
  });

  it('R2 оценивается раньше R1: доза с императивом получает класс dosage, не treatment (§4)', () => {
    const order = RESPONSE_GUARD_RULES.map((r) => r.id);
    expect(order.indexOf('R2')).toBeLessThan(order.indexOf('R1'));
  });
});

describe('лог-событие guardrail.replace — без текста ответа (§18, AC §20 п.4)', () => {
  it('replace → info("guardrail.replace", {ruleId, refusalClass, note}); ответ в аргументы не попадает', () => {
    const logger = spyLogger();
    const answer = UNSAFE_ANSWERS[0]!.text;
    const result = toReplace(guardWith(logger).check(answer));
    expect(logger.info).toHaveBeenCalledTimes(1);
    const call = logger.info.mock.calls[0];
    expect(call).toBeDefined();
    const [message, meta] = call!;
    expect(message).toBe('guardrail.replace');
    expect(meta).toMatchObject({
      ruleId: result.ruleId,
      refusalClass: result.refusalClass,
    });
    const dumped = JSON.stringify([message, meta]);
    expect(dumped).not.toContain(answer);
    expect(dumped).not.toContain('Эналаприл');
  });

  it('pass → логгер молчит (событие только на замену, §5)', () => {
    const logger = spyLogger();
    guardWith(logger).check('Обычный ответ про данные.');
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('замена — полный текст отказа (AC §20 п.3, снапшот)', () => {
  it('текст замены == результат фабрики refusalClass, дословно', () => {
    const result = toReplace(guardWith(spyLogger()).check('Рекомендую принимать Эналаприл 10 мг.'));
    expect(result.refusalClass).toBe('dosage');
    expect(result.text).toBe(TEST_REFUSAL_TEXT('dosage'));
    expect(result.text.length).toBeGreaterThan(20);
    expect(result.text).not.toContain('Эналаприл');
  });

  it('класс отказа определяет текст: разные классы — разные шаблоны фабрики', () => {
    const logger = spyLogger();
    const guard = guardWith(logger);
    const dose = toReplace(guard.check('Принимайте 5 мг утром.'));
    const diagnosis = toReplace(guard.check('Диагноз: гипертоническая болезнь.'));
    expect(diagnosis.refusalClass).toBe('diagnosis');
    expect(dose.text).toBe(TEST_REFUSAL_TEXT('dosage'));
    expect(diagnosis.text).toBe(TEST_REFUSAL_TEXT('diagnosis'));
    expect(dose.text).not.toBe(diagnosis.text);
  });
});

describe('fail-safe: regex-сбой → замена, не pass (§14, AC §20 п.5)', () => {
  /** Мок паттерна, имитирующий катастрофу/сбой — .test всегда бросает. */
  const THROWING_PATTERN = {
    test: () => {
      throw new Error('ReDoS: catastrophic backtracking');
    },
  } as unknown as RegExp;

  it('бросающее простое правило → replace его классом (сомнение = замена)', () => {
    const rule: GuardRule = {
      id: 'X-THROW',
      pattern: THROWING_PATTERN,
      action: 'replace',
      refusalClass: 'treatment',
      noteKey: 'test.throwing',
    };
    const guard = new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT, rules: [rule] });
    expect(guard.check('Спокойный ответ про данные.')).toEqual({
      action: 'replace',
      text: TEST_REFUSAL_TEXT('treatment'),
      ruleId: 'X-THROW',
      refusalClass: 'treatment',
    });
  });

  it('бросающее условное правило (requireImperativeContext) → replace (§14)', () => {
    const rule: GuardRule = {
      id: 'X-THROW-CTX',
      pattern: THROWING_PATTERN,
      action: 'replace',
      refusalClass: 'dosage',
      noteKey: 'test.throwing.ctx',
      requireImperativeContext: true,
    };
    const guard = new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT, rules: [rule] });
    expect(guard.check('Принимайте 5 мг утром.').action).toBe('replace');
  });

  it('бросающее условное правило на тексте БЕЗ императива → replace, не pass (§14: сбой оценки ≠ отсутствие совпадения)', () => {
    // Ревью TASK-085: после СБОЯ оценки условного правила гейт §13 применять
    // нельзя — «сбой + нет императива» дал бы pass (fail-open). Сомнение = замена:
    // правило сработавшее при сбое оценки считается БЕЗУСЛОВНО.
    const rule: GuardRule = {
      id: 'X-THROW-CTX-NO-IMPERATIVE',
      pattern: THROWING_PATTERN,
      action: 'replace',
      refusalClass: 'dosage',
      noteKey: 'test.throwing.ctx.no-imperative',
      requireImperativeContext: true,
    };
    const guard = new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT, rules: [rule] });
    expect(guard.check('Ваше давление стабильно за период.')).toEqual({
      action: 'replace',
      text: TEST_REFUSAL_TEXT('dosage'),
      ruleId: 'X-THROW-CTX-NO-IMPERATIVE',
      refusalClass: 'dosage',
    });
  });

  it('сбой оценки ПРЕДЛОЖЕНИЯ дозы (partial-throw паттерн) → replace, не pass (§14)', () => {
    // Вторая точка сбоя (ревью TASK-085): оценка ВСЕГО ответа здорова, а оценка
    // предложения бросает — здесь сбой тоже не может кончиться pass.
    const THROWS_ON_SHORT = {
      test: (input: string) => {
        if (input.length <= 30) {
          throw new Error('оценка предложения не удалась');
        }
        return true;
      },
    } as unknown as RegExp;
    const rule: GuardRule = {
      id: 'X-THROW-SENTENCE',
      pattern: THROWS_ON_SHORT,
      action: 'replace',
      refusalClass: 'dosage',
      noteKey: 'test.throwing.sentence',
      requireImperativeContext: true,
    };
    const guard = new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT, rules: [rule] });
    // Полный ответ > 30 символов (оценка здорова → true), предложение «Давление
    // стабильно.» ≤ 30 — его оценка бросает; императива/AUX в тексте нет.
    expect(guard.check('Давление стабильно. Показатели ровные.')).toEqual({
      action: 'replace',
      text: TEST_REFUSAL_TEXT('dosage'),
      ruleId: 'X-THROW-SENTENCE',
      refusalClass: 'dosage',
    });
  });

  it('инъекция правил работает: пустой состав → всё pass (правила — данные, §5)', () => {
    const guard = new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT, rules: [] });
    expect(guard.check('Принимайте 5 мг.')).toEqual({ action: 'pass' });
  });

  it('без логгера (опциональная зависимость) замена не падает', () => {
    const guard = new ResponseGuard({ refusalText: TEST_REFUSAL_TEXT });
    expect(guard.check('Принимайте 5 мг.').action).toBe('replace');
  });
});
