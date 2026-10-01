/**
 * TASK-087 §19/§20/§22: юнит-тесты use case GenerateSummary на fake-зависимостях
 * (портовый набор §5 «портовых юнит-тестов на fake-engine»):
 *  1. miss → generate → save (все поля, data_version захвачен);
 *  2. hit → БЕЗ вызова движка (spy) + cached=true (§20 п.2);
 *  3. мутация → stale=true (unit; сквозной — интеграция §20 п.3);
 *  4. cancel → записи нет, движок остановлен (done-cancelled), финал один (§20 п.4);
 *  5. refusal 086 → мгновенный шаблон, engine spy чист, записи нет (§13);
 *  6. guard-replace → записи нет + replace-событие в логе (§9/§20 п.5);
 *  7. BUSY: второй generate → AppError AI/BUSY, первый не задет (§9/§13);
 *  8. гонка cancel vs done (§22): первый финал фиксирует исход;
 *  9. модель не выбрана → AI/ENGINE_NOT_CONFIGURED до движка;
 * 10. инвариант дисклеймера/периода (§20 п.6) + сверка константы с промптом 084 (§17);
 * 11. custom-период: границы как есть, periodText — настенные даты;
 * 12. 'all' → сентинелы границ (0..now), periodText «весь журнал»;
 * 13. сбой движка (AppError из стрима) → execute отклоняется, слот освобождён.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  HlEventMap,
  PeriodStatisticsDto,
  StatsPeriodParam,
  TrendResponse,
} from '@hl/contracts';
import { AppError, type Clock } from '@hl/kernel';

import { UNSAFE_ANSWERS } from './__fixtures__/unsafe-answers.js';
import { FakeLlmEngine, FAKE_LLM_PREFIX } from '../adapters/fake-llm-engine.js';
import { DEFAULT_GUARDRAIL_POLICY } from '../domain/guardrail-policy.js';
import type { AiContext, AiContextInput } from './ai-context-builder.js';
import {
  AI_SUMMARY_DISCLAIMER_TEXT,
  GenerateSummary,
  type GenerateSummaryOutcome,
} from './generate-summary.js';
import type {
  InsightRepository,
  SummaryPeriod,
  SummaryRecord,
} from './ports/insight-repository.js';
import {
  type EngineStatus,
  type LlmEngine,
  type LlmEngineChunk,
  type LlmEngineRequest,
} from './ports/llm-engine.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import { PrecheckService } from './precheck-service.js';
import { refusalText } from './refusal-texts.js';
import { ResponseGuard } from './response-guard.js';

const NOW_MS = 1_758_816_000_000;
const DAY = 86_400_000;

const CLOCK: Clock = { nowMs: () => NOW_MS, tzOffsetMin: () => 180 };

const PROFILE = 'seed-profile-0001';

/** Статистика периода «достаточно данных» (порог kernel — префильтр 086 молчит). */
const ENOUGH_STATS: PeriodStatisticsDto = {
  count: 20,
  sys: { avg: 124, min: 110, max: 138, sd: 6 },
  dia: { avg: 79, min: 70, max: 88, sd: 4 },
  pulse: { avg: 66, min: 58, max: 76, sd: 3 },
  critical: { high: false, low: false },
  daysWithMeasurements: 14,
  longestStreakDays: 6,
  insufficientData: { tooFewMeasurements: false, tooFewDays: false },
};

/** Статистика «данных мало» — префильтр 086 даёт отказ (§13 refusal). */
const INSUFFICIENT_STATS: PeriodStatisticsDto = {
  ...ENOUGH_STATS,
  count: 2,
  daysWithMeasurements: 1,
  insufficientData: { tooFewMeasurements: true, tooFewDays: true },
};

const EMPTY_SERIES: TrendResponse = { mode: 'raw', points: [] };

/** Стаб сборщика контекста: фиксированный hash/текст, вход эхом (§19 подмены). */
class StubContextBuilder {
  callCount = 0;
  lastInput: AiContextInput | undefined;

  constructor(
    private readonly contextHash: string,
    private readonly stats: PeriodStatisticsDto = ENOUGH_STATS,
  ) {}

  build(input: AiContextInput): Promise<AiContext> {
    this.callCount += 1;
    this.lastInput = input;
    return Promise.resolve({
      text: `ПЕРИОД: ${typeof input.period === 'string' ? input.period : 'custom'}`,
      contextHash: this.contextHash,
      sections: ['period'],
      period: input.period,
      includeNotes: input.includeNotes,
      modelId: input.modelId,
      stats: this.stats,
      series: EMPTY_SERIES,
      gaps: [],
    });
  }
}

/** Fake-репозиторий в памяти (§19: юниты use case — fake-repo). */
class FakeInsightRepository implements InsightRepository {
  readonly rows = new Map<string, SummaryRecord>();
  currentVersion = 1;
  saveCalls = 0;

  findByContextHash(profileId: string, contextHash: string): Promise<SummaryRecord | undefined> {
    for (const row of this.rows.values()) {
      if (row.profileId === profileId && row.contextHash === contextHash) {
        return Promise.resolve(row);
      }
    }
    return Promise.resolve(undefined);
  }

  save(record: SummaryRecord): Promise<void> {
    this.saveCalls += 1;
    this.rows.set(record.id, record);
    return Promise.resolve();
  }

  latestForPeriod(profileId: string, period: StatsPeriodParam): Promise<SummaryRecord | undefined> {
    let latest: SummaryRecord | undefined;
    for (const row of this.rows.values()) {
      // Сопоставление как в SqliteInsightRepository (§12/ревью): пресет/'all' — по
      // каноническому periodParam, custom — по точным границам.
      const matches =
        row.profileId === profileId &&
        (typeof period === 'string'
          ? row.periodParam === period
          : row.periodParam === 'custom' &&
            row.period.fromUtcMs === period.fromUtcMs &&
            row.period.toUtcMs === period.toUtcMs);
      if (matches && (latest === undefined || row.createdAtUtc > latest.createdAtUtc)) {
        latest = row;
      }
    }
    return Promise.resolve(latest);
  }

  deleteAll(): Promise<void> {
    this.rows.clear();
    return Promise.resolve();
  }

  currentDataVersion(): Promise<number> {
    return Promise.resolve(this.currentVersion);
  }
}

/** Очередь управляемого движка: чанк или отказ стрима. */
type QueuedItem = { readonly chunk: LlmEngineChunk } | { readonly error: AppError };

/**
 * Управляемый движок: чанки выдаются только после push — детерминизм отмены/гонки
 * (§19); контракт доставки порта соблюдён (ошибка — первым шагом итерации, финал —
 * последний чанк, abort на паузе — done(cancelled)).
 */
class ControlledEngine implements LlmEngine {
  ensureModelCalls: string[] = [];
  completeCalls: LlmEngineRequest[] = [];
  private queue: QueuedItem[] = [];
  private readonly waiters: Array<() => void> = [];

  /** Поставить следующий чанк стрима. */
  push(chunk: LlmEngineChunk): void {
    this.queue.push({ chunk });
    this.wake();
  }

  /** Отказать стриму (первый шаг итерации бросит AppError — контракт порта). */
  fail(error: AppError): void {
    this.queue.push({ error });
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) {
      resolve();
    }
  }

  ensureModel(modelId: string): Promise<void> {
    this.ensureModelCalls.push(modelId);
    return Promise.resolve();
  }

  cancel(): void {
    // Кооперативная отмена не используется тестами — abort-сигнал в запросе.
  }

  status(): EngineStatus {
    return { loaded: this.ensureModelCalls.length > 0, busy: false };
  }

  complete(request: LlmEngineRequest): AsyncIterable<LlmEngineChunk> {
    this.completeCalls.push(request);
    // abort на паузе будит стрим (контракт порта §13: done(cancelled) немедленно).
    request.signal.addEventListener('abort', () => this.wake(), { once: true });
    return this.stream(request);
  }

  /** Генератор стрима (отдельный метод — без this-алиасинга, §19 гигиена). */
  private async *stream(request: LlmEngineRequest): AsyncGenerator<LlmEngineChunk> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        if ('error' in next) {
          // Контракт порта: отказ (AppError по построению) — первым шагом итерации.
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок порта — AppError (TASK-006)
          throw next.error;
        }
        yield next.chunk;
        if (next.chunk.done !== undefined) {
          return; // финал — последний чанк
        }
        continue;
      }
      if (request.signal.aborted) {
        // abort на паузе — немедленный done(cancelled) (контракт порта §13).
        yield { done: 'cancelled' };
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** События notify (spy). */
type RecordedEvent = { readonly name: string; readonly payload: unknown };

function recordingNotify(): {
  events: RecordedEvent[];
  notify: <K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]) => void;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    notify: (name, payload) => {
      events.push({ name, payload });
    },
  };
}

interface LogLine {
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

/** Логи (spy). */
function recordingLogger(): {
  lines: LogLine[];
  logger: { info(message: string, meta?: Record<string, unknown>): void };
} {
  const lines: LogLine[] = [];
  return { lines, logger: { info: (message, meta) => void lines.push({ message, meta }) } };
}

interface HarnessOptions {
  readonly stats?: PeriodStatisticsDto;
  readonly contextHash?: string;
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly engine?: LlmEngine;
  /** TASK-091 §9: test-hook отключения эшелонов 2/3 (eval). */
  readonly guardrailsEnabled?: boolean;
}

/** Сборка use case с fake-зависимостями + ручки наблюдения. */
function makeUseCase(options: HarnessOptions = {}): {
  useCase: GenerateSummary;
  repo: FakeInsightRepository;
  engine: LlmEngine;
  context: StubContextBuilder;
  events: RecordedEvent[];
  guardLog: LogLine[];
  logs: LogLine[];
} {
  const context = new StubContextBuilder(options.contextHash ?? 'h'.repeat(64), options.stats);
  const repo = new FakeInsightRepository();
  const engine = options.engine ?? new FakeLlmEngine();
  const { events, notify } = recordingNotify();
  const { lines: guardLog, logger: guardLogger } = recordingLogger();
  const { lines: logs, logger } = recordingLogger();
  const useCase = new GenerateSummary({
    context,
    precheck: new PrecheckService({ refusalText }),
    guard: new ResponseGuard({ refusalText, logger: guardLogger }),
    engine,
    repo,
    modelMeta: () =>
      Promise.resolve({
        modelId: options.modelId ?? 'test-model',
        modelVersion: options.modelVersion ?? '1.0.0',
      }),
    notify,
    clock: CLOCK,
    logger,
    locale: 'ru',
    guardrailsEnabled: options.guardrailsEnabled,
  });
  return { useCase, repo, engine, context, events, guardLog, logs };
}

const BASE_COMMAND = {
  profileId: PROFILE,
  period: '30d' as StatsPeriodParam,
  includeNotes: false,
  requestId: 'req-1',
};

/** Ожидаемые границы пресета 30d от фиксированных часов (§13: from = now − N*24ч, to = ∞ → now). */
const EXPECTED_PERIOD_30D: SummaryPeriod = { fromUtcMs: NOW_MS - 30 * DAY, toUtcMs: NOW_MS };

/** Единственная запись fake-repo (после успешного miss-пути). */
function onlyRecord(repo: FakeInsightRepository): SummaryRecord {
  const records = [...repo.rows.values()];
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    throw new Error('fake-repo пуст');
  }
  return record;
}

/** Единственное событие имени (ровно один — финализация §22). */
function onlyEvent(events: RecordedEvent[], name: string): unknown {
  const matching = events.filter((event) => event.name === name);
  expect(matching).toHaveLength(1);
  return matching[0]?.payload;
}

describe('GenerateSummary — полный поток UC-03 (TASK-087 §19)', () => {
  it('(1) miss → генерация → save: все поля записи, data_version захвачен, финал с summaryId', async () => {
    const { useCase, repo, context, events, logs } = makeUseCase();
    repo.currentVersion = 7; // «текущий» счётчик — в запись идёт именно он (§5 save)

    const outcome = await useCase.execute(BASE_COMMAND);

    // Без expect.any(...) (typed-lint: any) — поля по одному.
    expect(outcome.requestId).toBe('req-1');
    expect(typeof outcome.summaryId).toBe('string');
    expect(outcome.cached).toBe(false);
    expect(outcome.stale).toBe(false);
    const record = onlyRecord(repo);
    expect(record.profileId).toBe(PROFILE);
    expect(record.contextHash).toBe('h'.repeat(64));
    expect(record.dataVersion).toBe(7);
    expect(record.modelId).toBe('test-model');
    expect(record.modelVersion).toBe('1.0.0');
    expect(record.createdAtUtc).toBe(NOW_MS);
    expect(record.period).toEqual(EXPECTED_PERIOD_30D);
    // Канонический параметр — ключ сопоставления latest (§12/ревью): пресет → сам пресет.
    expect(record.periodParam).toBe('30d');
    // Инвариант §20 п.6: дисклеймер/период — отдельные поля, заполнены всегда.
    expect(record.disclaimerText).toBe(AI_SUMMARY_DISCLAIMER_TEXT);
    expect(record.periodText.length).toBeGreaterThan(0);
    expect(record.contentMd.startsWith(FAKE_LLM_PREFIX)).toBe(true);
    // Контекст собран с modelId (участник hash §2).
    expect(context.lastInput).toEqual({
      profileId: PROFILE,
      period: '30d',
      includeNotes: false,
      modelId: 'test-model',
    });
    // Финал — ровно одно событие 'ai/summary/result' с summaryId (§11).
    expect(onlyEvent(events, 'ai/summary/result')).toEqual({
      requestId: 'req-1',
      summaryId: record.id,
      cached: false,
      stale: false,
    });
    // Токены стрима доставлялись событиями ai:token с ТЕМ ЖЕ requestId (§11).
    const tokens = events.filter((event) => event.name === 'ai:token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(
      tokens.every((event) => (event.payload as { requestId: string }).requestId === 'req-1'),
    ).toBe(true);
    // Телеметрия §18: модель/duration/tokens/cached — без текста (PHI).
    const genLog = logs.find((line) => line.message === 'ai/summary/generate');
    expect(genLog?.meta?.['model']).toBe('test-model');
    expect(genLog?.meta?.['cached']).toBe(false);
    expect(typeof genLog?.meta?.['tokens']).toBe('number');
    expect(typeof genLog?.meta?.['durationMs']).toBe('number');
    expect(JSON.stringify(genLog?.meta)).not.toContain(FAKE_LLM_PREFIX);
    expectTypeOf(outcome).toEqualTypeOf<GenerateSummaryOutcome>();
  });

  it('(2) hit → engine НЕ вызван (spy), cached=true, токенов нет (§20 п.2)', async () => {
    const engine = new FakeLlmEngine();
    const completeSpy = vi.spyOn(engine, 'complete');
    const ensureSpy = vi.spyOn(engine, 'ensureModel');
    const { useCase, repo, events } = makeUseCase({ engine });
    await repo.save({
      id: 'cached-1',
      profileId: PROFILE,
      periodParam: '30d',
      period: EXPECTED_PERIOD_30D,
      contextHash: 'h'.repeat(64),
      modelId: 'test-model',
      modelVersion: '1.0.0',
      dataVersion: 5,
      contentMd: 'Прошлое резюме',
      disclaimerText: AI_SUMMARY_DISCLAIMER_TEXT,
      periodText: 'последние 30 дней',
      createdAtUtc: NOW_MS - 1000,
    });

    const outcome = await useCase.execute(BASE_COMMAND);

    expect(outcome).toEqual({
      requestId: 'req-1',
      summaryId: 'cached-1',
      cached: true,
      stale: false,
    });
    expect(completeSpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(events.filter((event) => event.name === 'ai:token')).toHaveLength(0);
    expect(events.filter((event) => event.name === 'ai/summary/result')).toHaveLength(1);
  });

  it('(3) ревью: hit после мутации через use case → {cached:true, stale:true} (§19/§20 п.1, боевая ветка cache-hit)', async () => {
    // Замечание ревью TASK-087: прежний тест (3) проверял арифметику ФИКСТУРЫ
    // (ручное сравнение на fake-репозитории), а боевая ветка stale в cache-hit
    // (generate-summary: cachedRecord.dataVersion < currentVersion) не была покрыта.
    // Здесь — полный путь use case: generate (data_version захвачен) → «мутация
    // данных» (счётчик вырос) → повторный execute → hit со stale=true.
    const { useCase, repo } = makeUseCase();
    const first = await useCase.execute(BASE_COMMAND);
    expect(first.cached).toBe(false);
    const record = onlyRecord(repo);
    expect(record.dataVersion).toBe(1); // текущий счётчик на момент save

    repo.currentVersion = 2; // «мутация данных»: add/update/delete двигают счётчик (§13)
    const second = await useCase.execute({ ...BASE_COMMAND, requestId: 'req-2' });

    expect(second).toEqual({
      requestId: 'req-2',
      summaryId: record.id,
      cached: true,
      stale: true, // data_version записи (1) < текущего (2) — бейдж «обновите разбор»
    });
  });

  it('(4) cancel → done(cancelled): записи нет, финал без summaryId, токены остановлены (§20 п.4)', async () => {
    const engine = new ControlledEngine();
    const { useCase, repo, events } = makeUseCase({ engine });
    const controller = new AbortController();
    const pending = useCase.execute({ ...BASE_COMMAND, signal: controller.signal });

    engine.push({ delta: 'первый ' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.name === 'ai:token')).toBe(true);
    });

    controller.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ requestId: 'req-1', cached: false, stale: false });
    expect(outcome.summaryId).toBeUndefined();
    expect(repo.rows.size).toBe(0); // частичный ответ НЕ сохранён (§5 п.5)
    // Финал ровно один — «done-cancelled» сигнал UI (§20 п.4).
    expect(events.filter((event) => event.name === 'ai/summary/result')).toHaveLength(1);
    // Движок остановлен: ensureModel дошёл (модель грузилась), после abort новых токенов нет.
    expect(engine.ensureModelCalls).toEqual(['test-model']);
    expect(events.filter((event) => event.name === 'ai:token')).toHaveLength(1);
  });

  it('(5) refusal 086 → мгновенный шаблон без движка и без записи (§13)', async () => {
    const engine = new FakeLlmEngine();
    const completeSpy = vi.spyOn(engine, 'complete');
    const ensureSpy = vi.spyOn(engine, 'ensureModel');
    const { useCase, repo, events } = makeUseCase({ engine, stats: INSUFFICIENT_STATS });

    const outcome = await useCase.execute(BASE_COMMAND);

    expect(outcome).toEqual({ requestId: 'req-1', cached: false, stale: false });
    expect(outcome.summaryId).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled(); // движок даже не грузился (§9)
    expect(repo.rows.size).toBe(0); // отказ-резюме НЕ сохраняется (решение §5)
    // Ответ-стрим из шаблона: refusal-текст ушёл токен-событием.
    const tokens = events.filter((event) => event.name === 'ai:token');
    expect(tokens).toHaveLength(1);
    expect((tokens[0]?.payload as { text: string }).text).toContain('Данных пока мало');
    expect(events.filter((event) => event.name === 'ai/summary/result')).toHaveLength(1);
  });

  it('(6) guard-replace → записи нет, в логе replace-событие (§9/§20 п.5)', async () => {
    // Fake-движок отвечает «красным» текстом из фикстур 085 — пост-фильтр обязан заменить.
    const unsafe = UNSAFE_ANSWERS[0];
    if (unsafe === undefined) {
      throw new Error('фикстура unsafe-answers пуста');
    }
    const engine = new FakeLlmEngine({
      scenarios: [{ keywords: ['период'], response: unsafe.text }],
    });
    const { useCase, repo, guardLog } = makeUseCase({ engine });

    const outcome = await useCase.execute(BASE_COMMAND);

    expect(outcome.summaryId).toBeUndefined();
    expect(outcome.cached).toBe(false);
    expect(repo.rows.size).toBe(0); // replace-ответ «не резюме» — решение §9
    // replace-событие §18 от ResponseGuard дошло в лог.
    const replace = guardLog.find((line) => line.message === 'guardrail.replace');
    expect(replace?.meta).toMatchObject({
      ruleId: unsafe.expectedRuleId,
      refusalClass: unsafe.expectedRefusalClass,
    });
  });

  it('(7) BUSY: второй generate во время первого → AppError AI/BUSY, первый не задет (§9)', async () => {
    const engine = new ControlledEngine();
    const { useCase, repo } = makeUseCase({ engine });
    const first = useCase.execute(BASE_COMMAND);
    engine.push({ delta: 'первый ' });
    await vi.waitFor(() => expect(engine.completeCalls.length).toBe(1));

    await expect(useCase.execute({ ...BASE_COMMAND, requestId: 'req-2' })).rejects.toMatchObject({
      code: 'AI/BUSY',
    });

    engine.push({ done: 'stop' });
    const outcome = await first;
    expect(outcome.summaryId).toBeDefined();
    expect(repo.rows.size).toBe(1);
  });

  it('(8) §22: гонка финалов — первый done(stop) фиксирует исход, поздний abort не ветирует', async () => {
    const engine = new ControlledEngine();
    const { useCase, repo, events } = makeUseCase({ engine });
    const controller = new AbortController();
    const pending = useCase.execute({ ...BASE_COMMAND, signal: controller.signal });

    engine.push({ delta: 'почти готов ' });
    engine.push({ done: 'stop' });
    // Гонка: abort прискакал ПОСЛЕ финала — исход уже зафиксирован (§22 идемпотентность).
    controller.abort();
    const outcome = await pending;

    expect(outcome.summaryId).toBeDefined();
    expect(repo.rows.size).toBe(1);
    expect(events.filter((event) => event.name === 'ai/summary/result')).toHaveLength(1);
  });

  it('(9) модель не выбрана (modelId="") → AI/ENGINE_NOT_CONFIGURED до движка', async () => {
    const engine = new FakeLlmEngine();
    const ensureSpy = vi.spyOn(engine, 'ensureModel');
    const { useCase, repo } = makeUseCase({ engine, modelId: '' });

    await expect(useCase.execute(BASE_COMMAND)).rejects.toMatchObject({
      code: 'AI/ENGINE_NOT_CONFIGURED',
    });
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(0);
  });

  it('(10) инвариант §20 п.6 + сверка дисклеймера с промптом 084 (§17)', async () => {
    const { useCase, repo } = makeUseCase();
    await useCase.execute(BASE_COMMAND);
    const record = onlyRecord(repo);
    // Служебные поля — отдельные от content_md, непустые, дисклеймер — RU-константа.
    expect(record.disclaimerText).toBe('Это не медицинская консультация.');
    expect(record.periodText).toBe('последние 30 дней');
    expect(record.contentMd).not.toContain(record.disclaimerText);

    // Сверка с LLM-слоем: константа согласована с ОБЯЗАТЕЛЬНО промпта 084 (§17).
    const prompt = buildSystemPrompt(DEFAULT_GUARDRAIL_POLICY, {
      periodText: record.periodText,
      hasGaps: false,
      insufficientData: false,
    });
    expect(prompt).toContain('Это не медицинская консультация');
    expect(prompt).toContain('Анализируемый период: последние 30 дней.');
  });

  it('(11) custom-период: границы как есть, periodText — настенные даты (DD.MM.YYYY)', async () => {
    const { useCase, repo } = makeUseCase({ contextHash: 'c'.repeat(64) });
    const from = NOW_MS - 2 * DAY;
    const outcome = await useCase.execute({
      ...BASE_COMMAND,
      period: { fromUtcMs: from, toUtcMs: NOW_MS },
    });

    expect(outcome.summaryId).toBeDefined();
    const record = onlyRecord(repo);
    expect(record.period).toEqual({ fromUtcMs: from, toUtcMs: NOW_MS });
    // Custom сопоставляется latest по границам — параметр 'custom' (§12/ревью).
    expect(record.periodParam).toBe('custom');
    // tz 180 → настенные даты по Clock (§17: RU-подпись main).
    expect(record.periodText).toMatch(/^\d{2}\.\d{2}\.\d{4}–\d{2}\.\d{2}\.\d{4}$/);
  });

  it("(12) 'all' → границы-сентинелы (0..now), periodText «весь журнал», параметр 'all'", async () => {
    const { useCase, repo } = makeUseCase({ contextHash: 'a'.repeat(64) });
    await useCase.execute({ ...BASE_COMMAND, period: 'all' });
    const record = onlyRecord(repo);
    expect(record.period).toEqual({ fromUtcMs: 0, toUtcMs: NOW_MS });
    expect(record.periodParam).toBe('all');
    expect(record.periodText).toBe('весь журнал наблюдений');
  });

  it('(13) сбой движка (AppError из стрима) → execute отклоняется, слот освобождён', async () => {
    const engine = new ControlledEngine();
    const { useCase, repo } = makeUseCase({ engine });
    const first = useCase.execute(BASE_COMMAND);
    await vi.waitFor(() => expect(engine.completeCalls.length).toBe(1));

    // Отказ стрима первым шагом итерации (контракт порта — как BUSY/CRASHED реального).
    engine.fail(AppError.of('AI/WORKER_CRASHED', 'errors.AI_WORKER_CRASHED', { reason: 'test' }));
    await expect(first).rejects.toMatchObject({ code: 'AI/WORKER_CRASHED' });
    expect(repo.rows.size).toBe(0);

    // Слот освобождён — следующий generate не BUSY и работает до конца.
    const secondEngine = new ControlledEngine();
    const { useCase: useCase2 } = makeUseCase({ engine: secondEngine });
    const second = useCase2.execute({ ...BASE_COMMAND, requestId: 'req-2' });
    secondEngine.push({ done: 'stop' });
    const outcome = await second;
    expect(outcome.summaryId).toBeDefined();
  });
});

/**
 * TASK-091 §9: test-hook guardrailsEnabled — параметр конструктора, дефолт true;
 * false отключает эшелоны 2/3 (префильтр 086 + пост-фильтр 085) ТОЛЬКО внутри
 * eval-процесса (контрольный --no-guardrails); в проде контейнер опцию не
 * экспонирует (§14 — тест-сверка в tools/eval/runner.int.test.ts).
 */
describe('GenerateSummary — test-hook guardrailsEnabled (TASK-091 §9)', () => {
  it('guardrailsEnabled=false: порог малых данных НЕ даёт отказ — резюме генерируется и сохраняется', async () => {
    const { useCase, repo, events } = makeUseCase({
      stats: INSUFFICIENT_STATS,
      guardrailsEnabled: false,
    });

    const outcome = await useCase.execute(BASE_COMMAND);

    // Отказ-путь не сохраняет резюме и не вызывает движок; выключенный префильтр
    // открывает LLM-путь → запись есть.
    expect(outcome.summaryId).toBeDefined();
    expect(repo.saveCalls).toBe(1);
    const tokenTexts = events
      .filter((event) => event.name === 'ai:token')
      .map((event) => (event.payload as { text: string }).text)
      .join('');
    expect(tokenTexts).not.toContain('Данных пока мало');
  });

  it('guardrailsEnabled=false: небезопасный ответ модели сохраняется как есть (эшелон 3 выключен)', async () => {
    const unsafe = UNSAFE_ANSWERS[0];
    if (unsafe === undefined) {
      throw new Error('фикстура 085 пуста');
    }
    const engine = new FakeLlmEngine({
      // Сценарная таблица матчит текст СООБЩЕНИЙ запроса (system+контекст):
      // «лекарств» есть в секции ЧТО ЗАПРЕЩЕНО промпта 084 — fake ответит
      // небезопасным текстом фикстуры.
      scenarios: [{ keywords: ['лекарств'], response: unsafe.text }],
    });
    const { useCase, repo } = makeUseCase({ engine, guardrailsEnabled: false });

    const outcome = await useCase.execute(BASE_COMMAND);

    expect(outcome.summaryId).toBeDefined();
    // Fake-движок ставит обязательный префикс [FAKE] (§16–17 078) — за ним текст
    // фикстуры дословно; пост-фильтр выключен, замены нет.
    expect(onlyRecord(repo).contentMd).toBe(`${FAKE_LLM_PREFIX} ${unsafe.text}`);
  });

  it('по умолчанию (опции нет) guardrails включены: малые данные → отказ-шаблон, движок чист', async () => {
    const engine = new FakeLlmEngine();
    const completeSpy = vi.spyOn(engine, 'complete');
    const { useCase } = makeUseCase({ stats: INSUFFICIENT_STATS, engine });

    const outcome = await useCase.execute(BASE_COMMAND);

    expect(outcome.summaryId).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });
});
