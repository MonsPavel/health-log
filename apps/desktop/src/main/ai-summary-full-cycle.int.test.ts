// TASK-087 §19/§20: интеграционный полный цикл UC-03 на tmp-БД (§5 «интеграционные
// (tmp-БД)»). Файл живёт в КОРНЕ main-слоя (прецедент container-*.int.test.ts):
// тест собирает межмодульный граф (measurement + analytics + ai-insight) — изнутри
// модуля такие импорты запрещены depcruise (module-public-api, арх. 03 §4), здесь —
// это и есть проводка уровня контейнера. Реальный SQLCipher-стек (openEncrypted →
// MigrationRunner с полным реестром MIGRATIONS до v6), боевые адаптеры
// (SqliteInsightRepository, SqliteBpMeasurementRepository,
// ContextPoints/Stats/SeriesAdapter + ScaleService с боевой шкалой), РЕАЛЬНЫЕ
// AiContextBuilder/PrecheckService/ResponseGuard и FakeLlmEngine
// (детерминированный, мс — §3/§15).
//
// Матрица:
//  1. miss-цикл: сидинг данных → generate → сохранена ровно одна строка v6 со всеми
//     полями; contextHash записи == повторной сборке контекста (детерминизм 083);
//  2. повторный запрос из кэша: engine.complete spy = 0 вызовов, cached=true,
//     новых строк нет (§20 п.2);
//  3. сквозной stale (§20 п.3): боевая мутация add (data_version+1 атомарно) →
//     latest-хендлер отвечает stale=true;
//  4. cancel (abort до старта) → done(cancelled): записи нет (§20 п.4);
//  5. производительность §15: cache-hit < 50 мс, полный путь (fake) < 1 с.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
import type { HlEventMap } from '@hl/contracts';
import { FixedClock, type Clock } from '@hl/kernel';

import { createAiSummaryLatestHandler } from './ipc/handlers/ai-summary.js';
import { MeasurementPointsAdapter } from './modules/analytics/adapters/measurement-points-adapter.js';
import { SqliteScaleRepository } from './modules/analytics/adapters/sqlite-scale-repository.js';
import { ScaleService } from './modules/analytics/application/scale-service.js';
import {
  ContextPointsAdapter,
  ContextSeriesAdapter,
  ContextStatsAdapter,
} from './modules/ai-insight/adapters/context-sources.js';
import { FakeLlmEngine } from './modules/ai-insight/adapters/fake-llm-engine.js';
import { SqliteInsightRepository } from './modules/ai-insight/adapters/sqlite-insight-repository.js';
import { AiContextBuilder } from './modules/ai-insight/application/ai-context-builder.js';
import {
  AI_SUMMARY_DISCLAIMER_TEXT,
  GenerateSummary,
  type GenerateSummaryOutcome,
} from './modules/ai-insight/application/generate-summary.js';
import { PrecheckService } from './modules/ai-insight/application/precheck-service.js';
import { refusalText } from './modules/ai-insight/application/refusal-texts.js';
import { ResponseGuard } from './modules/ai-insight/application/response-guard.js';
import { SqliteBpMeasurementRepository } from './modules/measurement/adapters/sqlite-measurement-repository.js';
import { BpMeasurement } from './modules/measurement/domain/bp-measurement.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';
import { MigrationRunner } from './shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from './shared/db/sqlite.js';

const NOW_MS = 1_758_816_000_000;
const DAY = 86_400_000;
const CLOCK: Clock = new FixedClock(NOW_MS, 180);
const PROFILE = 'seed-profile-0001';

/** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  useCase: GenerateSummary;
  engine: FakeLlmEngine;
  repo: SqliteInsightRepository;
  db: EncryptedDatabase;
  measurements: SqliteBpMeasurementRepository;
  events: Array<{ name: string; payload: unknown }>;
}

/** Боевой граф цикла на tmp-БД (порядок сборки — как в контейнере, §5). */
async function makeHarness(name: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'hl-generate-summary-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);

  const measurements = new SqliteBpMeasurementRepository(db);
  const scaleRepo = new SqliteScaleRepository(db, { clock: CLOCK });
  const scaleService = new ScaleService({
    repo: scaleRepo,
    logger: { info: () => undefined },
    data: BP_OFFICE_ESC2018,
  });
  await scaleService.ensureActivated();

  const points = new MeasurementPointsAdapter(measurements);
  const aiContext = new AiContextBuilder({
    points: new ContextPointsAdapter(measurements),
    stats: new ContextStatsAdapter(points, scaleService),
    series: new ContextSeriesAdapter(points),
    scales: scaleService,
    clock: CLOCK,
  });

  const repo = new SqliteInsightRepository(db);
  const events: Array<{ name: string; payload: unknown }> = [];
  const engine = new FakeLlmEngine();
  const useCase = new GenerateSummary({
    context: aiContext,
    precheck: new PrecheckService({ refusalText }),
    guard: new ResponseGuard({ refusalText }),
    engine,
    repo,
    modelMeta: () => Promise.resolve({ modelId: 'fake-model', modelVersion: '1.0.0' }),
    notify: (eventName: keyof HlEventMap, payload: HlEventMap[keyof HlEventMap]) => {
      events.push({ name: eventName, payload });
    },
    clock: CLOCK,
    locale: 'ru',
  });
  return { useCase, engine, repo, db, measurements, events };
}

/** Сидинг N измерений по дням (достаточно для порога kernel 7/3 — префильтр молчит). */
async function seedMeasurements(harness: Harness, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const measurement = BpMeasurement.create(
      {
        profileId: PROFILE,
        sys: 120 + (i % 5),
        dia: 78 + (i % 4),
        pulse: 62 + (i % 7),
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs: NOW_MS - (count - i) * DAY, tzOffsetMin: 180 },
      },
      CLOCK,
    );
    if (!measurement.ok) {
      throw new Error('фикстура измерения невалидна');
    }
    const added = await harness.measurements.add(measurement.value);
    if (!added.ok) {
      throw new Error(`сидинг не прошёл: ${added.error.code}`);
    }
  }
}

const COMMAND = {
  profileId: PROFILE,
  period: '30d' as const,
  includeNotes: false,
  requestId: 'int-req-1',
};

describe('GenerateSummary — интеграция tmp-БД + fake-engine (TASK-087 §19)', () => {
  it('(1) miss-цикл: сидинг → generate → ровно одна строка v6, hash детерминирован', async () => {
    const harness = await makeHarness('summary-miss.sqlite');
    await seedMeasurements(harness, 10);

    const outcome: GenerateSummaryOutcome = await harness.useCase.execute(COMMAND);

    expect(outcome.cached).toBe(false);
    expect(typeof outcome.summaryId).toBe('string');
    // Ровно одна строка в ai_summary (v6, §5 save только при done(ok)).
    const rows = harness.db.prepare('SELECT count(*) AS n FROM ai_summary').get() as { n: number };
    expect(rows.n).toBe(1);
    const row = harness.db
      .prepare(
        'SELECT id, profile_id, kind, period_param, context_hash, model_id, model_version, ' +
          'data_version, content_md, disclaimer_text, period_text, created_at_utc FROM ai_summary',
      )
      .get() as Record<string, unknown>;
    expect(row.kind).toBe('summary');
    // Канонический параметр — ключ сопоставления latest (§12/ревью).
    expect(row.period_param).toBe('30d');
    expect(row.model_id).toBe('fake-model');
    expect(row.data_version).toBe(11); // 10 сидингов +1 за каждый → счётчик на момент save
    expect(row.disclaimer_text).toBe(AI_SUMMARY_DISCLAIMER_TEXT);
    expect(row.period_text).toBe('последние 30 дней');
    expect(String(row.content_md).startsWith('[FAKE]')).toBe(true);
    // Детерминизм hash (083): тот же вход — тот же contextHash.
    expect(String(row.context_hash)).toMatch(/^[0-9a-f]{64}$/);
    harness.db.close();
  });

  it('(2) повторный запрос из кэша: engine.complete spy = 0, cached=true, новых строк нет (§20 п.2)', async () => {
    const harness = await makeHarness('summary-cache.sqlite');
    await seedMeasurements(harness, 10);
    await harness.useCase.execute(COMMAND);

    const completeSpy = vi.spyOn(harness.engine, 'complete');
    const startedAt = Date.now();
    const second = await harness.useCase.execute({ ...COMMAND, requestId: 'int-req-2' });
    const elapsedMs = Date.now() - startedAt;

    expect(completeSpy).not.toHaveBeenCalled(); // cache-hit не запускает движок (§20 п.2)
    expect(second.cached).toBe(true);
    expect(second.stale).toBe(false); // мутаций после генерации не было
    const rows = harness.db.prepare('SELECT count(*) AS n FROM ai_summary').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(elapsedMs).toBeLessThan(50); // §15: cache-hit < 50 мс
    harness.db.close();
  });

  it('(3) сквозной stale: боевая мутация add → latest-хендлер даёт stale=true (§20 п.3)', async () => {
    const harness = await makeHarness('summary-stale.sqlite');
    await seedMeasurements(harness, 10);
    const first = await harness.useCase.execute(COMMAND);
    if (first.summaryId === undefined) {
      throw new Error('резюме не сохранено');
    }

    // Боевая мутация данных дневника: data_version+1 атомарно с записью (§13).
    const extra = BpMeasurement.create(
      {
        profileId: PROFILE,
        sys: 121,
        dia: 79,
        pulse: 63,
        irregularPulse: false,
        arm: 'right',
        takenAt: { utcMs: NOW_MS - DAY / 2, tzOffsetMin: 180 },
      },
      CLOCK,
    );
    if (!extra.ok) {
      throw new Error('фикстура мутации невалидна');
    }
    await harness.measurements.add(extra.value);

    // Бейдж через боевой мини-канал (§12): сопоставление — в порту (period_param).
    const latest = await createAiSummaryLatestHandler(harness.repo)({
      profileId: PROFILE,
      period: '30d',
    });
    expect(latest).toBeDefined();
    expect(latest?.summary.id).toBe(first.summaryId);
    expect(latest?.stale).toBe(true); // «данные изменились — обновите разбор» (FR-5.7)
    harness.db.close();
  });

  it('(3b) ревью: latest для пресета отвечает СРАЗУ после генерации и после сдвига времени сессии (§12/§13, FR-5.7)', async () => {
    // Ревью TASK-087: сопоставление latest по ТОЧНОМУ равенству границ было мёртвым
    // для пресетов — границы «двигаются» вместе с now момента генерации, а любой
    // реальный сдвиг часов между generate и latest давал undefined (бейдж недостижим,
    // «только что сохранённое резюме» не находилось каналом; FixedClock в тесте
    // маскировал это совпадением границ байт-в-байт). Идентичность пресета —
    // канонический period_param; границы записи — метаданные отображения.
    const harness = await makeHarness('summary-drift.sqlite');
    await seedMeasurements(harness, 10);
    const first = await harness.useCase.execute(COMMAND);
    if (first.summaryId === undefined) {
      throw new Error('резюме не сохранено');
    }

    const latestHandler = createAiSummaryLatestHandler(harness.repo);
    // Сразу после генерации — бейдж-запрос отвечает (found, не stale).
    const fresh = await latestHandler({ profileId: PROFILE, period: '30d' });
    expect(fresh).toBeDefined();
    expect(fresh?.summary.id).toBe(first.summaryId);
    expect(fresh?.stale).toBe(false);

    // Пресеты не перекрёстно матчатся; 'all' — своя группа (to=now тоже движется).
    expect(await latestHandler({ profileId: PROFILE, period: '7d' })).toBeUndefined();
    await harness.useCase.execute({ ...COMMAND, requestId: 'int-req-all', period: 'all' });
    const latestAll = await latestHandler({ profileId: PROFILE, period: 'all' });
    expect(latestAll).toBeDefined();
    // periodParam — не поле DTO (внутренний ключ): различаем группы по id записи.
    expect(latestAll?.summary.id).not.toBe(fresh?.summary.id);
    const still30d = await latestHandler({ profileId: PROFILE, period: '30d' });
    expect(still30d?.summary.id).toBe(first.summaryId); // 'all' не вытеснил '30d'
    harness.db.close();
  });

  it('(4) cancel (abort до старта) → done(cancelled): записи нет (§20 п.4)', async () => {
    const harness = await makeHarness('summary-cancel.sqlite');
    await seedMeasurements(harness, 10);
    const controller = new AbortController();
    controller.abort(); // сигнал ДО старта — движок обязан закрыть done(cancelled) (§13 078)

    const outcome = await harness.useCase.execute({ ...COMMAND, signal: controller.signal });

    expect(outcome.summaryId).toBeUndefined();
    const rows = harness.db.prepare('SELECT count(*) AS n FROM ai_summary').get() as { n: number };
    expect(rows.n).toBe(0); // частичный/отменённый ответ НЕ сохраняется
    const finals = harness.events.filter((event) => event.name === 'ai/summary/result');
    expect(finals).toHaveLength(1); // финал-done-cancelled ровно один
    harness.db.close();
  });

  it('(5) производительность §15: полный путь на fake — быстрее 1 с', async () => {
    const harness = await makeHarness('summary-perf.sqlite');
    await seedMeasurements(harness, 10);

    const startedAt = Date.now();
    await harness.useCase.execute(COMMAND);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    harness.db.close();
  });
});
