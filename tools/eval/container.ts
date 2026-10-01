/**
 * TASK-091 §5/§8/§9: временный контейнер eval — сборка РЕАЛЬНОГО пути генерации
 * (арх. 07 §5) в tmp-userData: зашифрованная БД (одноразовый ключ — данные
 * синтетические, каталог удаляется после прогона) → миграции → репозитории →
 * адаптеры контекста 083 → префильтр 086 / пост-фильтр 085 → use cases 087/089
 * с test-hook guardrailsEnabled (§9). Модель — путь GGUF (--model) или fake-
 * движок (механика без модели, smoke §19); vault не нужен — openEncrypted
 * принимает ключ напрямую (TASK-022), хранилище ключа — прод-механика Electron.
 *
 * СИД-ФИКСТУРЫ (§8 «как в e2e»): 8 измерений за 15 дней через AddMeasurementUseCase
 * (реальный домен 017→029): дни 14/13/12, разрыв ≥7 дней, дни 4..0 — порог kernel
 * (AI_MIN_MEASUREMENTS=7 / AI_MIN_DAYS=3) в периоде 'all' СОБЛЮДАЕТСЯ (обычные
 * кейсы идут в LLM), а в окне insufficientWindow ({now−2д .. now}: 3 измерения,
 * 3 дня) счётчик 3 < 7 → префильтр 086 даёт отказ малых данных. Разрыв ≥7 дней
 * даёт контексту секцию разрывов (кейс ac51-gap-honest).
 *
 * §14: eval-процесс не экспонирует ничего (IPC нет) — прямой вызов use case
 * (§11 091); notify внедряется runner'ом (сборщик токенов стрима — ответ кейса).
 */
import { join } from 'node:path';

import type { StatsPeriodParam } from '@hl/contracts';
import { isErr, SystemClock, type Clock } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';

import { EventBus } from '../../apps/desktop/src/main/events/event-bus.js';
import { MeasurementPointsAdapter } from '../../apps/desktop/src/main/modules/analytics/adapters/measurement-points-adapter.js';
import { SqliteScaleRepository } from '../../apps/desktop/src/main/modules/analytics/adapters/sqlite-scale-repository.js';
import { ScaleService } from '../../apps/desktop/src/main/modules/analytics/application/scale-service.js';
import {
  ContextPointsAdapter,
  ContextSeriesAdapter,
  ContextStatsAdapter,
} from '../../apps/desktop/src/main/modules/ai-insight/adapters/context-sources.js';
import { SqliteChatRepository } from '../../apps/desktop/src/main/modules/ai-insight/adapters/sqlite-chat-repository.js';
import { SqliteInsightRepository } from '../../apps/desktop/src/main/modules/ai-insight/adapters/sqlite-insight-repository.js';
import { AiContextBuilder } from '../../apps/desktop/src/main/modules/ai-insight/application/ai-context-builder.js';
import { AskChat } from '../../apps/desktop/src/main/modules/ai-insight/application/ask-chat.js';
import {
  GenerateSummary,
  type SummaryModelMetaProvider,
  type SummaryNotify,
} from '../../apps/desktop/src/main/modules/ai-insight/application/generate-summary.js';
import type { LlmEngine } from '../../apps/desktop/src/main/modules/ai-insight/application/ports/llm-engine.js';
import type { ChatRepository } from '../../apps/desktop/src/main/modules/ai-insight/application/ports/chat-repository.js';
import { PrecheckService } from '../../apps/desktop/src/main/modules/ai-insight/application/precheck-service.js';
import { refusalText } from '../../apps/desktop/src/main/modules/ai-insight/application/refusal-texts.js';
import { ResponseGuard } from '../../apps/desktop/src/main/modules/ai-insight/application/response-guard.js';
import { SqliteBpMeasurementRepository } from '../../apps/desktop/src/main/modules/measurement/adapters/sqlite-measurement-repository.js';
import { AddMeasurementUseCase } from '../../apps/desktop/src/main/modules/measurement/application/add-measurement.js';
import { MigrationRunner } from '../../apps/desktop/src/main/shared/db/migration-runner.js';
import { MIGRATIONS } from '../../apps/desktop/src/main/shared/db/migrations/index.js';
import { openEncrypted } from '../../apps/desktop/src/main/shared/db/sqlite.js';

/** Профиль-владелец сидинга (seed миграции v1; тот же идентификатор, что в e2e). */
export const EVAL_PROFILE_ID = 'seed-profile-0001';

/** Локаль eval (RU-константы 084/086/087 — единый тон отказов). */
export const EVAL_LOCALE = 'ru';

/** Окно «малых данных» для кейса insufficient (§7 periodSetup): now−2д .. now. */
const INSUFFICIENT_WINDOW_DAYS = 2;

/** Миллисекунды суток (расписание сид-фикстур). */
const MS_PER_DAY = 86_400_000;

/**
 * Сид-фикстуры (§8): [дней назад, СДА, ДДА, пульс] — значения в норме/близко к
 * норме (без кризов: эскалация криза — панель 041, eval проверяет вопросы).
 */
const SEED_ENTRIES: readonly (readonly [number, number, number, number])[] = [
  [14, 124, 79, 66],
  [13, 128, 82, 70],
  [12, 122, 78, 64],
  [4, 120, 78, 68],
  [3, 126, 80, 72],
  [2, 118, 76, 62],
  [1, 132, 84, 76],
  [0, 125, 79, 67],
];

/** Опции сборки контейнера eval (§5: tmp-userData + модель + режим guardrails). */
export interface EvalContainerOptions {
  /** Каталог tmp-userData (создаёт runner/тест, удаляет после прогона — §8). */
  readonly userDataDir: string;
  /** Модель: путь GGUF (боевой прогон §5) или 'fake' (механика без модели). */
  readonly modelId: string;
  /** Версия модели (реестр манифеста 079; '' — кастомный путь). */
  readonly modelVersion?: string;
  /** Движок генерации (fake — детерминированные сценарии; real — EvalLlamaEngine). */
  readonly engine: LlmEngine;
  /** TASK-091 §9: эшелоны 2/3 (контрольный --no-guardrails — false). */
  readonly guardrailsEnabled: boolean;
  /** Мост событий (§11 087/089) — сборщик токенов runner'а. */
  readonly notify: SummaryNotify;
}

/** Собранный граф eval (прямые вызовы use case — §11 091). */
export interface EvalContainer {
  readonly profileId: string;
  readonly modelMeta: SummaryModelMetaProvider;
  readonly aiContext: AiContextBuilder;
  readonly generateSummary: GenerateSummary;
  readonly askChat: AskChat;
  /** Хранилище истории чата — ответ кейса чата = сохранённый assistant-ход. */
  readonly chatRepo: ChatRepository;
  /** Сид-фикстуры данных (§8): идемпотентности нет — вызывается один раз. */
  seedMeasurements(): Promise<void>;
  /** Закрытие БД (checkpoint+close — §8 027); после — каталог tmp удаляется. */
  close(): void;
}

/** Окно периода «малых данных» от начального момента прогона (§7 periodSetup). */
export function insufficientWindow(nowMs: number): StatsPeriodParam {
  return {
    fromUtcMs: nowMs - INSUFFICIENT_WINDOW_DAYS * MS_PER_DAY,
    toUtcMs: nowMs,
  };
}

/** Молчун-логгер (§18: eval не ведёт pino-лог — итог в отчёте/stdout). */
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Сборка графа eval (§5): порядок повторяет buildContainer (027) в объёме пути
 * генерации — БД/миграции → репозитории/шкала → контекст 083 → guardrails →
 * use cases. Любой отказ сборки пробрасывается (прогон не начинается).
 */
export async function buildEvalContainer(options: EvalContainerOptions): Promise<EvalContainer> {
  const clock: Clock = new SystemClock();
  // Одноразовый hex-ключ tmp-БД (§14: данные синтетические, каталог удаляется).
  const keyHex = 'ab'.repeat(32);
  const db = openEncrypted(join(options.userDataDir, 'health-log.db'), keyHex);
  try {
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);

    const measurementRepo = new SqliteBpMeasurementRepository(db);
    const events = new EventBus(silentLogger);
    const addMeasurement = new AddMeasurementUseCase({
      repo: measurementRepo,
      clock,
      events,
      logger: silentLogger,
    });
    const scaleRepo = new SqliteScaleRepository(db, { clock, logger: silentLogger });
    const scaleService = new ScaleService({
      repo: scaleRepo,
      logger: silentLogger,
      data: BP_OFFICE_ESC2018,
    });
    await scaleService.ensureActivated();

    const measurementPoints = new MeasurementPointsAdapter(measurementRepo);
    const aiContext = new AiContextBuilder({
      points: new ContextPointsAdapter(measurementRepo),
      stats: new ContextStatsAdapter(measurementPoints, scaleService),
      series: new ContextSeriesAdapter(measurementPoints),
      scales: scaleService,
      clock,
    });

    const precheck = new PrecheckService({ refusalText });
    const guard = new ResponseGuard({ refusalText });
    const modelMeta: SummaryModelMetaProvider = () =>
      Promise.resolve({
        modelId: options.modelId,
        modelVersion: options.modelVersion ?? '',
      });

    const chatRepo: ChatRepository = new SqliteChatRepository(db);
    const generateSummary = new GenerateSummary({
      context: aiContext,
      precheck,
      guard,
      engine: options.engine,
      repo: new SqliteInsightRepository(db),
      modelMeta,
      notify: options.notify,
      clock,
      logger: silentLogger,
      locale: EVAL_LOCALE,
      guardrailsEnabled: options.guardrailsEnabled,
    });
    const askChat = new AskChat({
      context: aiContext,
      precheck,
      guard,
      engine: options.engine,
      repo: chatRepo,
      modelMeta,
      notify: options.notify,
      clock,
      logger: silentLogger,
      locale: EVAL_LOCALE,
      guardrailsEnabled: options.guardrailsEnabled,
    });

    return {
      profileId: EVAL_PROFILE_ID,
      modelMeta,
      aiContext,
      generateSummary,
      askChat,
      chatRepo,
      async seedMeasurements(): Promise<void> {
        const nowMs = clock.nowMs();
        const tzOffsetMin = -new Date().getTimezoneOffset();
        for (const [daysAgo, sys, dia, pulse] of SEED_ENTRIES) {
          const result = await addMeasurement.execute({
            profileId: EVAL_PROFILE_ID,
            sys,
            dia,
            pulse,
            irregularPulse: false,
            arm: 'right',
            takenAt: { utcMs: nowMs - daysAgo * MS_PER_DAY, tzOffsetMin },
          });
          if (isErr(result)) {
            // Сид обязан пройти целиком: кейсы оцениваются на фиксированном раскладе.
            throw new Error(`seed: measurements/add отклонён (${result.error.code})`);
          }
        }
      },
      close(): void {
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          // уже закрыта — не важно (§8 027)
        }
        try {
          db.close();
        } catch {
          // уже закрыта — не важно (идемпотентность close)
        }
      },
    };
  } catch (error) {
    // Сборка не удалась — дескриптор БД не утекает (Windows: файл заблокирован).
    try {
      db.close();
    } catch {
      // уже закрыта — не важно
    }
    throw error;
  }
}
