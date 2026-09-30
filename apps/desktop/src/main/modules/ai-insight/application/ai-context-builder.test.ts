// TASK-083 §19/§20/§13: юнит-тесты AiContextBuilder — детерминизм (§13: перестановка
// записей → байт-одинаковый text/hash; повторная сборка → байт-в-байт; «сейчас» в
// тексте/хеше не участвует), разрывы ≥7 дней (EC-08: разрыв 14 дней найден, дни
// посчитаны; ведущий разрыв «от периода до первой записи», §7), excludeNotes
// (§14: без опции — ни байта заметок, секции нет), лимит CONTEXT_MAX_DAYS=90
// (§5/§20: 120-дневный период → агрегированные серии + пометка), состав hash
// (§2: period + опции + текст + modelId + PROMPT_TEMPLATE_VERSION), пометки
// critical/irregular в сериях (§5), пустой период — не ошибка, бюджет §15 (<100 мс).
//
// Порты — подстановочные (§19): stats/series считаются БОЕВЫМИ read models
// (buildPeriodStatistics 052/054, buildTrendResponse 056) над теми же точками —
// юнит проверяет сборку контекста, не переопределяя чужую математику.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AI_CONTEXT_SECTION_IDS,
  type PeriodStatisticsDto,
  type TrendResponse,
} from '@hl/contracts';
import { FixedClock, Instant, type Clock } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
import {
  buildPeriodStatistics,
  buildTrendResponse,
  type MeasurementPoint,
} from '../../analytics/index.js';

import { assessCritical } from '../../measurement/index.js';
import type { ContextPoint, ContextPointsPort, ContextPointsQuery } from './ports/ai-context.js';
import {
  AiContextBuilder,
  AiContextBuilderDeps,
  CONTEXT_MAX_DAYS,
  PROMPT_TEMPLATE_VERSION,
} from './ai-context-builder.js';

/** «Сейчас» FixedClock — после всех фикстурных дат (детерминизм, NFR-10). */
const NOW_MS = Instant.fromIso('2026-03-31T12:00:00.000+03:00').utcMs;
/** Пояс всех тестовых точек: UTC+03:00 → 180 минут. */
const TZ = 180;

/** Точка контекста из настенного времени (детерминизм фикстур). */
function ctxPoint(
  dayIso: string,
  wallTime: string,
  sys: number,
  dia: number,
  pulse: number | undefined = undefined,
  extra: Partial<ContextPoint> = {},
): ContextPoint {
  return {
    sys,
    dia,
    pulse,
    takenAt: Instant.fromIso(`${dayIso}T${wallTime}:00.000+03:00`),
    critical: assessCritical(sys, dia),
    ...extra,
  };
}

/** Фильтрация точек включительными границами запроса (семантика порта TASK-021 §13). */
function filterByQuery(points: readonly ContextPoint[], q: ContextPointsQuery): ContextPoint[] {
  return points.filter(
    (p) =>
      (q.fromUtcMs === undefined || p.takenAt.utcMs >= q.fromUtcMs) &&
      (q.toUtcMs === undefined || p.takenAt.utcMs <= q.toUtcMs),
  );
}

/** Подстановочный порт точек (§19): фиксированный массив, границы как есть. */
class FakePoints implements ContextPointsPort {
  constructor(private readonly points: ContextPoint[]) {}
  listByPeriod(q: ContextPointsQuery): Promise<ContextPoint[]> {
    return Promise.resolve(filterByQuery(this.points, q));
  }
}

/** Зависимости сборщика над боевыми read models 052/054/056 и одной точкой правды. */
function makeDeps(
  points: ContextPoint[],
  clock: Clock = new FixedClock(NOW_MS, TZ),
): AiContextBuilderDeps {
  const scale = BP_OFFICE_ESC2018;
  return {
    points: new FakePoints(points),
    stats: {
      getStatistics: (q) => {
        const selected: MeasurementPoint[] = filterByQuery(points, q);
        // toDto 054: JSON round-trip — undefined-части исчезают, форма = провод.
        const stats = JSON.parse(
          JSON.stringify(buildPeriodStatistics(selected, scale)),
        ) as PeriodStatisticsDto;
        return Promise.resolve(stats);
      },
    },
    series: {
      getSeries: (q, mode): Promise<TrendResponse> =>
        Promise.resolve(buildTrendResponse(filterByQuery(points, q), mode)),
    },
    scales: { getActiveScale: () => Promise.resolve(scale) },
    clock,
  };
}

const INPUT = {
  profileId: 'profile-1',
  period: {
    fromUtcMs: Instant.fromIso('2026-03-01T00:00:00.000+03:00').utcMs,
    toUtcMs: Instant.fromIso('2026-03-31T23:59:00.000+03:00').utcMs,
  },
  includeNotes: true,
  modelId: 'test-model',
} as const;

describe('AiContextBuilder — детерминизм (§13)', () => {
  it('повторная сборка тех же данных — байт-в-байт text и hash (§2, §13)', async () => {
    const points = [
      ctxPoint('2026-03-02', '07:30', 118, 76, 58),
      ctxPoint('2026-03-03', '07:30', 120, 78),
      ctxPoint('2026-03-04', '07:30', 122, 80, 64),
    ];
    const builder = new AiContextBuilder(makeDeps(points));
    const first = await builder.build(INPUT);
    const second = await builder.build(INPUT);
    expect(second.text).toBe(first.text);
    expect(second.contextHash).toBe(first.contextHash);
  });

  it('property: перестановка записей (id уникальны) → байт-одинаковый text и hash (§13/§20)', async () => {
    // Прод-записи всегда имеют id (uuid v7 агрегата — адаптер порта), поэтому
    // полный порядок (utc asc, id asc) инвариантен к порядку выборки. Генератор
    // держит utcMs уникальными: в тестах id-меньше точки с равным utc не дают
    // полного порядка — прод-вход такой формы не производит. Перестановка —
    // детерминированный Fisher–Yates по seed fast-check (fc.shuffle в v4 нет).
    const rowArb = fc.record({
      utcMs: fc.integer({ min: 1_577_836_800_000, max: 1_831_232_000_000 }),
      sys: fc.integer({ min: 90, max: 180 }),
      dia: fc.integer({ min: 50, max: 110 }),
      pulse: fc.option(fc.integer({ min: 40, max: 150 }), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rowArb, { maxLength: 24, selector: (row) => row.utcMs }),
        fc.nat(),
        async (rows, seed) => {
          const points: ContextPoint[] = rows.map((row, i) => ({
            id: `uuid-${i}`,
            sys: row.sys,
            dia: row.dia,
            pulse: row.pulse,
            takenAt: { utcMs: row.utcMs, tzOffsetMin: TZ },
            critical: assessCritical(row.sys, row.dia),
          }));
          const builder = new AiContextBuilder(makeDeps(points));
          const input = { ...INPUT, period: 'all' as const };
          const base = await builder.build(input);
          const shuffled = seededShuffle(points, seed);
          const permuted = await new AiContextBuilder(makeDeps(shuffled)).build(input);
          expect(permuted.text).toBe(base.text);
          expect(permuted.contextHash).toBe(base.contextHash);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('одинаковый custom-период в разные дни календаря → идентичный text и hash (§13)', async () => {
    const points = [ctxPoint('2026-03-02', '07:30', 118, 76, 58)];
    const march = new AiContextBuilder(
      makeDeps(points, new FixedClock(Instant.fromIso('2026-03-15T09:00:00.000+03:00').utcMs, TZ)),
    );
    const december = new AiContextBuilder(
      makeDeps(points, new FixedClock(Instant.fromIso('2026-12-15T09:00:00.000+03:00').utcMs, TZ)),
    );
    const a = await march.build(INPUT);
    const b = await december.build(INPUT);
    expect(b.text).toBe(a.text);
    expect(b.contextHash).toBe(a.contextHash);
  });

  it('в тексте нет дат «сейчас»: период в тексте — только сам период (§4/§9)', async () => {
    const points = [ctxPoint('2026-03-02', '07:30', 118, 76, 58)];
    const ctx = await new AiContextBuilder(
      makeDeps(points, new FixedClock(Instant.fromIso('2027-06-01T00:00:00.000+03:00').utcMs, TZ)),
    ).build(INPUT);
    expect(ctx.text).toContain('Диапазон: 01.03.2026–31.03.2026');
    expect(ctx.text).not.toContain('2027');
  });
});

describe('AiContextBuilder — разрывы ≥7 дней (§5/§7/§13, EC-08)', () => {
  it('разрыв 14 дней посреди периода найден, дни посчитаны (EC-08, фикстура (c) 052)', async () => {
    const points = [
      ...daysFrom('2026-03-01', 7, (day) => ctxPoint(day, '08:00', 121, 81, 65)),
      ...daysFrom('2026-03-22', 3, (day) => ctxPoint(day, '20:00', 129, 84, 70)),
      ctxPoint('2026-03-24', '12:00', 125, 83),
    ];
    const ctx = await new AiContextBuilder(makeDeps(points)).build(INPUT);
    expect(ctx.gaps).toEqual([{ fromWallDate: '2026-03-08', toWallDate: '2026-03-21', days: 14 }]);
    expect(ctx.text).toContain('08.03–21.03 (14 дней)');
  });

  it('граница правила: пропуск ровно 7 дней найден, 6 дней — нет (§5 «≥7 дней»)', async () => {
    const seven = [
      ctxPoint('2026-03-01', '08:00', 120, 80),
      ctxPoint('2026-03-09', '08:00', 122, 82), // пропущено 02.03–08.03 = 7 дней
    ];
    const ctxSeven = await new AiContextBuilder(makeDeps(seven)).build(INPUT);
    expect(ctxSeven.gaps).toEqual([
      { fromWallDate: '2026-03-02', toWallDate: '2026-03-08', days: 7 },
    ]);

    const six = [
      ctxPoint('2026-03-01', '08:00', 120, 80),
      ctxPoint('2026-03-08', '08:00', 122, 82), // пропущено 6 дней — не разрыв
    ];
    const ctxSix = await new AiContextBuilder(makeDeps(six)).build(INPUT);
    expect(ctxSix.gaps).toEqual([]);
  });

  it('ведущий разрыв «от периода до первой записи» найден (§7); для «всего журнала» его нет', async () => {
    const points = [ctxPoint('2026-03-10', '08:00', 120, 80)];
    const ctx = await new AiContextBuilder(makeDeps(points)).build(INPUT);
    expect(ctx.gaps).toEqual([{ fromWallDate: '2026-03-01', toWallDate: '2026-03-09', days: 9 }]);
    expect(ctx.text).toContain('01.03–09.03 (9 дней)');

    const allCtx = await new AiContextBuilder(makeDeps(points)).build({
      ...INPUT,
      period: 'all' as const,
    });
    expect(allCtx.gaps).toEqual([]);
  });
});

describe('AiContextBuilder — заметки и includeNotes (§5/§14/§20)', () => {
  const noted = [
    ctxPoint('2026-03-02', '07:30', 118, 76, 58, { note: 'измерил после подъёма' }),
    ctxPoint('2026-03-03', '20:10', 134, 86, 72, {
      note: 'забыл таблетку\nутром',
      irregular: true,
    }),
    ctxPoint('2026-03-04', '07:30', 122, 80, 64),
  ];

  it('includeNotes=true: секция присутствует, текст заметки — построчно с датой, переносы схлопнуты (§5)', async () => {
    const ctx = await new AiContextBuilder(makeDeps(noted)).build(INPUT);
    expect(ctx.sections).toContain('notes');
    expect(ctx.text).toContain('02.03 — измерил после подъёма');
    // Многострочная заметка не ломает построчный формат (§4: секции — построчные).
    expect(ctx.text).toContain('03.03 — забыл таблетку утром');
    expect(ctx.text).not.toContain('\nутром');
  });

  it('excludeNotes: секции «Заметки» нет в text, ни байта заметок (§14/§20 байт-тест)', async () => {
    const withNotes = await new AiContextBuilder(makeDeps(noted)).build(INPUT);
    const without = await new AiContextBuilder(makeDeps(noted)).build({
      ...INPUT,
      includeNotes: false,
    });
    expect(without.sections).not.toContain('notes');
    expect(without.text).not.toContain('[notes]');
    expect(without.text).not.toContain('измерил после подъёма');
    expect(without.text).not.toContain('забыл таблетку');
    expect(without.contextHash).not.toBe(withNotes.contextHash);
  });

  it('includeNotes=true без заметок в данных — секция есть, «Нет заметок в периоде»', async () => {
    const points = [ctxPoint('2026-03-02', '07:30', 118, 76, 58)];
    const ctx = await new AiContextBuilder(makeDeps(points)).build(INPUT);
    expect(ctx.sections).toContain('notes');
    expect(ctx.text).toContain('Нет заметок в периоде');
  });
});

describe('AiContextBuilder — пометки в сериях (§5: критические/irregular)', () => {
  it('critical high/low и irregular помечены в строках raw-серии (§5)', async () => {
    const points: ContextPoint[] = [
      ctxPoint('2026-03-02', '07:30', 185, 110, 90), // high по TASK-020
      ctxPoint('2026-03-03', '08:00', 88, 58, 55), // low
      { ...ctxPoint('2026-03-04', '20:00', 128, 82, 70), irregular: true },
    ];
    const ctx = await new AiContextBuilder(makeDeps(points)).build(INPUT);
    expect(ctx.text).toContain('02.03 07:30 — 185/110, пульс 90 [КРИТИЧЕСКОЕ: высокое]');
    expect(ctx.text).toContain('03.03 08:00 — 88/58, пульс 55 [КРИТИЧЕСКОЕ: пониженное]');
    expect(ctx.text).toContain('04.03 20:00 — 128/82, пульс 70 [неровный пульс]');
  });
});

describe('AiContextBuilder — лимит объёма CONTEXT_MAX_DAYS (§5/§20)', () => {
  it('константа = 90 (§5), PROMPT_TEMPLATE_VERSION = v1-template (плейсхолдер до TASK-084, §5)', () => {
    expect(CONTEXT_MAX_DAYS).toBe(90);
    expect(PROMPT_TEMPLATE_VERSION).toBe('v1-template');
  });

  it('120-дневный период → агрегированные серии + пометка «Данные агрегированы» (§20)', async () => {
    const start = Instant.fromIso('2026-01-01T08:00:00.000+03:00').utcMs;
    const points: ContextPoint[] = Array.from({ length: 120 }, (_, i) => ({
      id: `d-${i}`,
      sys: 120,
      dia: 80,
      pulse: 60,
      takenAt: { utcMs: start + i * 86_400_000, tzOffsetMin: TZ },
      critical: undefined,
    }));
    const period = {
      fromUtcMs: Instant.fromIso('2026-01-01T00:00:00.000+03:00').utcMs,
      toUtcMs: Instant.fromIso('2026-04-30T23:59:00.000+03:00').utcMs,
    };
    const ctx = await new AiContextBuilder(makeDeps(points)).build({ ...INPUT, period });
    expect(ctx.series.mode).toBe('daily');
    expect(ctx.text).toContain('Данные агрегированы по дням');
    expect(ctx.text).toContain(
      '01.01 — СДА 120 (120–120), ДДА 80 (80–80), утро 120, пульс 60, n=1',
    );
  });

  it('90-дневный период — на границе лимита: детальные серии без пометки (§5 «> эквивалента»)', async () => {
    const start = Instant.fromIso('2026-01-01T08:00:00.000+03:00').utcMs;
    const points: ContextPoint[] = Array.from({ length: 90 }, (_, i) => ({
      id: `d-${i}`,
      sys: 121,
      dia: 81,
      pulse: undefined,
      takenAt: { utcMs: start + i * 86_400_000, tzOffsetMin: TZ },
      critical: undefined,
    }));
    const period = {
      fromUtcMs: Instant.fromIso('2026-01-01T00:00:00.000+03:00').utcMs,
      toUtcMs: Instant.fromIso('2026-03-31T23:59:00.000+03:00').utcMs,
    };
    const ctx = await new AiContextBuilder(makeDeps(points)).build({ ...INPUT, period });
    expect(ctx.series.mode).toBe('raw');
    expect(ctx.text).not.toContain('Данные агрегированы');
  });
});

describe('AiContextBuilder — состав contextHash (§2/§5)', () => {
  const points = [ctxPoint('2026-03-02', '07:30', 118, 76, 58, { note: 'ноут' })];

  it('hash — hex SHA-256; смена modelId / includeNotes / периода меняет hash (§2)', async () => {
    const builder = new AiContextBuilder(makeDeps(points));
    const base = await builder.build(INPUT);
    expect(base.contextHash).toMatch(/^[0-9a-f]{64}$/);

    const otherModel = await builder.build({ ...INPUT, modelId: 'other-model' });
    expect(otherModel.contextHash).not.toBe(base.contextHash);

    const noNotes = await builder.build({ ...INPUT, includeNotes: false });
    expect(noNotes.contextHash).not.toBe(base.contextHash);

    const otherPeriod = await builder.build({
      ...INPUT,
      period: {
        fromUtcMs: INPUT.period.fromUtcMs,
        toUtcMs: Instant.fromIso('2026-03-09T23:59:00.000+03:00').utcMs,
      },
    });
    expect(otherPeriod.contextHash).not.toBe(base.contextHash);
  });

  it('AiContext отражает вход: period/includeNotes/modelId и read models (§7)', async () => {
    const builder = new AiContextBuilder(makeDeps(points));
    const ctx = await builder.build(INPUT);
    expect(ctx.period).toEqual(INPUT.period);
    expect(ctx.includeNotes).toBe(true);
    expect(ctx.modelId).toBe('test-model');
    expect(ctx.stats.count).toBe(1);
    expect(ctx.series.mode).toBe('raw');
    expect(ctx.gaps).toEqual([]);
    expect(ctx.sections).toEqual([...AI_CONTEXT_SECTION_IDS]);
  });
});

describe('AiContextBuilder — края и бюджет (§11/§15)', () => {
  it('пустой период — валидный контекст без ошибок (прецедент 054/056 §11)', async () => {
    const ctx = await new AiContextBuilder(makeDeps([])).build(INPUT);
    expect(ctx.stats.count).toBe(0);
    expect(ctx.series).toEqual({ mode: 'raw', points: [] });
    expect(ctx.gaps).toEqual([]);
    expect(ctx.text).toContain('Измерений: 0');
  });

  it('пресет периода — в тексте метка пресета, без дат «сейчас» (§9)', async () => {
    const points = [ctxPoint('2026-03-20', '08:00', 120, 80, 60)];
    const ctx = await new AiContextBuilder(makeDeps(points)).build({ ...INPUT, period: '30d' });
    expect(ctx.text).toContain('Диапазон: последние 30 дней');
    expect(ctx.text).not.toContain('Диапазон: 0');
  });

  it('«весь журнал» — метка без границ (§9)', async () => {
    const points = [ctxPoint('2026-03-20', '08:00', 120, 80, 60)];
    const ctx = await new AiContextBuilder(makeDeps(points)).build({ ...INPUT, period: 'all' });
    expect(ctx.text).toContain('Диапазон: весь журнал');
  });

  it('90-дневный период собирается быстрее 100 мс (§15 тест-ориентир)', async () => {
    const start = Instant.fromIso('2026-01-01T08:00:00.000+03:00').utcMs;
    const points: ContextPoint[] = [];
    for (let i = 0; i < 90; i += 1) {
      const day = start + i * 86_400_000;
      points.push(
        {
          id: `m-${i}`,
          sys: 120 + (i % 5),
          dia: 80 + (i % 4),
          pulse: 60 + (i % 7),
          takenAt: { utcMs: day, tzOffsetMin: TZ },
          critical: undefined,
        },
        {
          id: `e-${i}`,
          sys: 122 + (i % 5),
          dia: 82 + (i % 4),
          pulse: undefined,
          takenAt: { utcMs: day + 43_200_000, tzOffsetMin: TZ },
          critical: undefined,
        },
      );
    }
    const builder = new AiContextBuilder(makeDeps(points));
    const startedAt = performance.now();
    await builder.build({ ...INPUT, period: '90d' });
    const durationMs = performance.now() - startedAt;
    expect(durationMs).toBeLessThan(100);
  });
});

/** Дни подряд от даты: помощник gap-фикстур (2026 — не високосный). */
function daysFrom(
  startIso: string,
  count: number,
  make: (dayIso: string) => ContextPoint,
): ContextPoint[] {
  const base = Instant.fromIso(`${startIso}T08:00:00.000+03:00`).utcMs;
  return Array.from({ length: count }, (_, i) => {
    const day = Instant.toIso({ utcMs: base + i * 86_400_000, tzOffsetMin: TZ }).slice(0, 10);
    return make(day);
  });
}

/** Детерминированная перестановка Fisher–Yates по целому seed (LCG; тестовая утилита). */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = (seed % 2_147_483_647) + 1;
  const next = (): number => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const atI = copy[i];
    const atJ = copy[j];
    if (atI !== undefined && atJ !== undefined) {
      copy[i] = atJ;
      copy[j] = atI;
    }
  }
  return copy;
}
