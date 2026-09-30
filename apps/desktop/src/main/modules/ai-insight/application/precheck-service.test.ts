// TASK-086 §19/§20: тесты PrecheckService — таблица redSetCase → PrecheckResult (§20
// п.1), пороги 7/3 kernel (3 записи → insufficient; 8 за 4 дня → undefined), приоритеты
// §13 (emergency перекрывает всё; криз в ПЕРИОДЕ эскалирует только вопросы о состоянии
// — решение §19), spy: при refusal LlmEngine.complete не вызван (§9/§20 п.6), лог
// precheck.refusal без текста вопроса (§18). Статистика — боевой read model 052
// (buildPeriodStatistics над ручными точками, прецедент system-prompt.test.ts).
import { describe, expect, it, vi } from 'vitest';

import type { PeriodStatisticsDto } from '@hl/contracts';
import { Instant } from '@hl/kernel';
import { buildPeriodStatistics, type MeasurementPoint } from '../../analytics/index.js';

import { RED_SET_CASES, type RedSetCase } from '../domain/red-set.js';
import { refusalText } from './refusal-texts.js';
import type { LlmEngine, LlmEngineChunk, LlmEngineRequest, EngineStatus } from './ports/llm-engine.js';
import { PrecheckService, isStateQuestion, type PrecheckContext } from './precheck-service.js';

/** Точка периода (та же механика, что в golden-фикстурах 052; пояс +03:00 без DST). */
function point(
  dayIso: string,
  wallTime: string,
  sys: number,
  dia: number,
  pulse: number | undefined = undefined,
  critical: 'high' | 'low' | undefined = undefined,
): MeasurementPoint {
  return {
    sys,
    dia,
    pulse,
    takenAt: Instant.fromIso(`${dayIso}T${wallTime}:00.000+03:00`),
    critical,
  };
}

/** `days` подряд с даты, по `perDay` слота 07:00/20:00 с фиксированными значениями. */
function regularPoints(
  startDayIso: string,
  days: number,
  perDay: number,
  opts: {
    readonly sys: number;
    readonly dia: number;
    readonly pulse?: number;
    readonly critical?: 'high' | 'low';
  },
): MeasurementPoint[] {
  const points: MeasurementPoint[] = [];
  for (let d = 0; d < days; d += 1) {
    const dayIso = `2026-03-${String(2 + d).padStart(2, '0')}`;
    for (let s = 0; s < perDay; s += 1) {
      points.push(point(dayIso, s === 0 ? '07:00' : '20:00', opts.sys, opts.dia, opts.pulse, opts.critical));
    }
  }
  return points;
}

/** СТАТИСТИКА ветвей (боевой read model 052 — один конструктор со списком точек). */
const SUFFICIENT = buildPeriodStatistics(regularPoints('2026-03-02', 4, 2, { sys: 125, dia: 82, pulse: 62 }));
const FEW = buildPeriodStatistics([
  point('2026-03-02', '07:00', 120, 80, 60),
  point('2026-03-02', '20:00', 130, 85, 70),
  point('2026-03-03', '07:00', 125, 82, 60),
]);
const CRISIS_PERIOD = buildPeriodStatistics(
  regularPoints('2026-03-02', 4, 2, { sys: 190, dia: 120, critical: 'high' }),
);
const LOW_PERIOD = buildPeriodStatistics(
  regularPoints('2026-03-02', 4, 2, { sys: 85, dia: 55, critical: 'low' }),
);
/** Малые данные И криз в периоде одновременно (угол §13: «emergency, не insufficient»). */
const FEW_CRISIS = buildPeriodStatistics([
  point('2026-04-01', '08:00', 125, 82, 70),
  point('2026-04-02', '07:30', 190, 110, 90, 'high'),
  point('2026-04-03', '08:00', 128, 84, 65),
  point('2026-04-03', '20:00', 200, 120, undefined, 'high'),
  point('2026-04-05', '08:00', 130, 85, 62),
]);

function ctxOf(stats: PeriodStatisticsDto, locale = 'ru'): PrecheckContext {
  return { stats, locale };
}

/** Сервис с боевой фабрикой текстов 086 и спай-логгером (§18). */
function service() {
  const logger = { info: vi.fn<(message: string, meta?: Record<string, unknown>) => void>() };
  return { svc: new PrecheckService({ refusalText, logger }), logger };
}

/** Спай движка LLM (§20 п.6): полный порт, счётчики вызовов читает тест. */
function engineSpy(): LlmEngine {
  return {
    ensureModel: vi.fn<(modelId: string) => Promise<void>>(),
    complete: vi.fn<(request: LlmEngineRequest) => AsyncIterable<LlmEngineChunk>>(),
    cancel: vi.fn<() => void>(),
    status: vi.fn<() => EngineStatus>(),
  };
}

describe('таблица redSetCase → PrecheckResult (§19/§20 п.1 — все классы)', () => {
  function ctxFor(c: RedSetCase): PrecheckContext {
    // Кейс «малых данных» — СЦЕНАРИЙ (шапка red-set.ts): реакция по счётчикам,
    // поэтому ему подаётся малый контекст; остальным — достаточный.
    return ctxOf(c.expected.kind === 'insufficient' ? FEW : SUFFICIENT);
  }

  for (const c of RED_SET_CASES) {
    it(`«${c.id}» → ${c.expected.kind}`, () => {
      const { svc } = service();
      const result = svc.check(c.question, ctxFor(c));

      if (c.expected.kind === 'answerWithDisclaimer') {
        expect(result).toBeUndefined();
        return;
      }
      expect(result).toBeDefined();
      if (c.expected.kind === 'emergency') {
        expect(result).toMatchObject({ kind: 'emergency' });
        expect((result as { text: string }).text).toContain('103');
        return;
      }
      expect(result).toMatchObject({
        kind: 'refusal',
        refusalClass:
          c.expected.kind === 'insufficient' ? 'insufficientData' : c.expected.refusalClass,
      });
      expect((result as { text: string }).text.length).toBeGreaterThan(0);
    });
  }
});

describe('пороги 7/3 (§20 п.2 — честный отказ при малых данных)', () => {
  it('3 записи за 2 дня → refusal insufficientData (оба порога нарушены)', () => {
    const { svc } = service();
    const result = svc.check('Сравни с нормой', ctxOf(FEW));
    expect(result).toMatchObject({ kind: 'refusal', refusalClass: 'insufficientData' });
    expect((result as { text: string }).text).toContain('(3 измерения за 2 дня)');
  });

  it('8 записей за 4 дня → undefined (идём в LLM, пороги соблюдены)', () => {
    const { svc } = service();
    expect(svc.check('Сравни с нормой', ctxOf(SUFFICIENT))).toBeUndefined();
  });

  it('7 записей за 3 дня — ровно на пороге kernel → undefined (границы включительно)', () => {
    const onThreshold = buildPeriodStatistics([
      ...regularPoints('2026-03-02', 2, 2, { sys: 125, dia: 82 }),
      ...regularPoints('2026-03-04', 1, 3, { sys: 125, dia: 82 }),
    ]);
    expect(onThreshold.count).toBe(7);
    expect(onThreshold.daysWithMeasurements).toBe(3);
    const { svc } = service();
    expect(svc.check('Сравни с нормой', ctxOf(onThreshold))).toBeUndefined();
  });
});

describe('приоритеты §13: emergency перекрывает всё', () => {
  it('криз-значения В ВОПРОСЕ при малых данных → emergency, не insufficient (§13)', () => {
    const { svc } = service();
    const result = svc.check('Мне 190/120 и болит голова, что делать?', ctxOf(FEW));
    expect(result).toMatchObject({ kind: 'emergency' });
  });

  it('криз-значения в вопросе перекрывают treatment-запрос («какие таблетки»)', () => {
    const { svc } = service();
    const result = svc.check('Мне 190/120, болит голова. Какие таблетки принять?', ctxOf(SUFFICIENT));
    expect(result).toMatchObject({ kind: 'emergency' });
  });
});

describe('эскалация из контекста: криз в ПЕРИОДЕ — только вопросы о состоянии (решение §19)', () => {
  it('«Как дела?» при кризисном периоде → emergency с текстом FR-7.4', () => {
    const { svc } = service();
    const result = svc.check('Как дела?', ctxOf(CRISIS_PERIOD));
    expect(result).toMatchObject({ kind: 'emergency' });
    expect((result as { text: string }).text).toContain('гипертонический криз');
  });

  it('«Что с моим давлением?» при кризисном периоде → emergency', () => {
    const { svc } = service();
    expect(svc.check('Что с моим давлением?', ctxOf(CRISIS_PERIOD))).toMatchObject({
      kind: 'emergency',
    });
  });

  it('«Какие тренды за месяц?» при кризисном периоде → undefined (безобидный — путь 087/084)', () => {
    const { svc } = service();
    expect(svc.check('Какие тренды за месяц?', ctxOf(CRISIS_PERIOD))).toBeUndefined();
  });

  it('«Сравни с нормой» при кризисном периоде → undefined (анализ не блокируется)', () => {
    const { svc } = service();
    expect(svc.check('Сравни с нормой', ctxOf(CRISIS_PERIOD))).toBeUndefined();
  });

  it('low-критические в периоде + «как дела» → undefined (эскалация только high-криза)', () => {
    const { svc } = service();
    expect(svc.check('Как дела?', ctxOf(LOW_PERIOD))).toBeUndefined();
  });

  it('без критических в периоде «как дела» → undefined (эскалация только при кризе)', () => {
    const { svc } = service();
    expect(svc.check('Как дела?', ctxOf(SUFFICIENT))).toBeUndefined();
  });

  it('малые данные + криз в периоде + «как дела» → emergency, НЕ insufficient (§13)', () => {
    const { svc } = service();
    expect(FEW_CRISIS.insufficientData.tooFewMeasurements).toBe(true);
    expect(FEW_CRISIS.critical.high).toBe(true);
    expect(svc.check('Как дела?', ctxOf(FEW_CRISIS))).toMatchObject({ kind: 'emergency' });
  });

  it('малые данные + криз в периоде + безобидный вопрос → insufficient (эскалации нет)', () => {
    const { svc } = service();
    expect(svc.check('Какие тренды за месяц?', ctxOf(FEW_CRISIS))).toMatchObject({
      kind: 'refusal',
      refusalClass: 'insufficientData',
    });
  });
});

describe('вопросы о состоянии — разграничение паттернов (§19)', () => {
  it('вопросы о состоянии распознаются', () => {
    for (const q of ['Как дела?', 'что с моим давлением', 'Всё ли в порядке?', 'Опасно ли это?']) {
      expect(isStateQuestion(q)).toBe(true);
    }
  });

  it('безобидные/аналитические вопросы — не вопросы о состоянии', () => {
    for (const q of [
      'Какие тренды за месяц?',
      'что было в разрыв, с 3 по 17 число?',
      'Сравни с нормой',
      'покажи среднее за неделю',
    ]) {
      expect(isStateQuestion(q)).toBe(false);
    }
  });
});

describe('Spy: при гарантированном ответе LlmEngine не участвует (§9/§20 п.6)', () => {
  it('refusal: complete/ensureModel не вызваны — ответ готов без модели', () => {
    const engine = engineSpy();
    const { svc } = service();
    const result = svc.check('Какие таблетки мне принять?', ctxOf(SUFFICIENT));
    expect(result).toMatchObject({ kind: 'refusal', refusalClass: 'treatment' });
    expect(engine.complete).not.toHaveBeenCalled();
    expect(engine.ensureModel).not.toHaveBeenCalled();
  });

  it('emergency: complete/ensureModel не вызваны — текст срочности мгновенный', () => {
    const engine = engineSpy();
    const { svc } = service();
    expect(svc.check('Мне 190/120 и болит голова, что делать?', ctxOf(SUFFICIENT))).toMatchObject({
      kind: 'emergency',
    });
    expect(engine.complete).not.toHaveBeenCalled();
    expect(engine.ensureModel).not.toHaveBeenCalled();
  });
});

describe('лог precheck.refusal — класс без текста вопроса (§18)', () => {
  it('refusal пишет класс; ни один вызов лога не содержит текст вопроса', () => {
    const { svc, logger } = service();
    const question = 'Какие таблетки мне принять?';
    svc.check(question, ctxOf(SUFFICIENT));
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('precheck.refusal', { class: 'treatment' });
    for (const call of logger.info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(question);
    }
  });

  it('emergency и insufficientData пишут свои классы; pass — лога нет', () => {
    const { svc, logger } = service();
    svc.check('Мне 190/120 и болит голова, что делать?', ctxOf(SUFFICIENT));
    svc.check('Сравни с нормой', ctxOf(FEW));
    svc.check('Сравни с нормой', ctxOf(SUFFICIENT));
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('precheck.refusal', { class: 'emergency' });
    expect(logger.info).toHaveBeenCalledWith('precheck.refusal', { class: 'insufficientData' });
  });
});
