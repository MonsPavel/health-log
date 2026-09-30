/**
 * TASK-087 §5/§11/§12: юнит-тесты хендлеров ai/summary + ai/cancel (слой тонкий,
 * прецедент ai-context.ts/ai-models.ts; §19 подмены):
 *  1. generate: мгновенный ответ {requestId} — фоновый запуск use case не держит
 *     вызов IPC (арх. 05 §3 «стриминг»); requestId уникален и совпадает с командой;
 *  2. generate: BUSY — если use case занят (isBusy), отказ AI/BUSY ДО ответа
 *     {requestId} (серверная защита §9: второй generate → ApiFailure);
 *  3. generate: сбой фонового execute не роняет хендлер (лог с кодом, без текста);
 *  4. cancel: abort активного requestId → {cancelled: true}; сигнаал дошёл до команды;
 *  5. cancel: незнакомый/повторный requestId → {cancelled: false} без ошибки (§13 076);
 *  6. latest: нет записи → undefined; есть → {summary: DTO, stale} с готовым флагом
 *     data_version (§12/§7); границы периода — resolveSummaryPeriod (тот же код, что
 *     у use case — без дрейфа).
 */
import { describe, expect, it } from 'vitest';

import { AppError, type Clock } from '@hl/kernel';

import {
  createAiSummaryCancelHandler,
  createAiSummaryGenerateHandler,
  createAiSummaryLatestHandler,
  AiSummaryRequestRegistry,
} from './ai-summary.js';
import type {
  GenerateSummary,
  GenerateSummaryCommand,
  GenerateSummaryOutcome,
} from '../../modules/ai-insight/application/generate-summary.js';
import { AI_SUMMARY_DISCLAIMER_TEXT } from '../../modules/ai-insight/application/generate-summary.js';
import type {
  InsightRepository,
  SummaryRecord,
} from '../../modules/ai-insight/application/ports/insight-repository.js';

const NOW_MS = 1_758_816_000_000;
const CLOCK: Clock = { nowMs: () => NOW_MS, tzOffsetMin: () => 180 };
const PROFILE = 'seed-profile-0001';

/** Stub use case: управляемый execute + isBusy. */
class StubGenerateSummary implements Partial<GenerateSummary> {
  busy = false;
  commands: GenerateSummaryCommand[] = [];
  private readonly resolvers: Array<(outcome: GenerateSummaryOutcome) => void> = [];
  /** Сбой следующего execute (§19: отказ фонового пути). */
  failure: Error | undefined;

  isBusy(): boolean {
    return this.busy;
  }

  execute(command: GenerateSummaryCommand): Promise<GenerateSummaryOutcome> {
    this.commands.push(command);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Сколько execute ещё подвисших (фон не завершился). */
  pendingCount(): number {
    return this.resolvers.length;
  }

  /** Завершить все подвисшие execute успешным исходом. */
  settleAll(summaryId = 's-1'): void {
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ requestId: 'x', summaryId, cached: false, stale: false });
    }
  }
}

/** Fake-репозиторий latest (минимальный). */
class FakeRepo implements InsightRepository {
  record: SummaryRecord | undefined;
  currentVersion = 1;

  findByContextHash(): Promise<SummaryRecord | undefined> {
    return Promise.resolve(undefined);
  }

  save(): Promise<void> {
    return Promise.resolve();
  }

  latestForPeriod(): Promise<SummaryRecord | undefined> {
    return Promise.resolve(this.record);
  }

  deleteAll(): Promise<void> {
    return Promise.resolve();
  }

  currentDataVersion(): Promise<number> {
    return Promise.resolve(this.currentVersion);
  }
}

interface LogLine {
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

function recordingLogger(): {
  lines: LogLine[];
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
} {
  const lines: LogLine[] = [];
  return { lines, logger: { warn: (message, meta) => void lines.push({ message, meta }) } };
}

describe('ai/summary/generate — хендлер (TASK-087 §11)', () => {
  it('(1) мгновенный {requestId}: фоновый запуск не держит вызов; requestId совпадает с командой', async () => {
    const useCase = new StubGenerateSummary();
    const registry = new AiSummaryRequestRegistry();
    const handler = createAiSummaryGenerateHandler(useCase, registry);

    const response = await handler({ profileId: PROFILE, period: '7d', includeNotes: false });

    // Ответ пришёл ДО завершения фонового execute (use case ещё подвис).
    expect(useCase.pendingCount()).toBe(1);
    expect(typeof response.requestId).toBe('string');
    expect(response.requestId.length).toBeGreaterThan(0);
    expect(useCase.commands).toHaveLength(1);
    expect(useCase.commands[0]).toMatchObject({
      profileId: PROFILE,
      period: '7d',
      includeNotes: false,
      requestId: response.requestId,
    });
    // Повторный вызов — НОВЫЙ requestId (корреляция стрима/финала §11).
    const second = await handler({ profileId: PROFILE, period: '7d', includeNotes: true });
    expect(second.requestId).not.toBe(response.requestId);
    useCase.settleAll();
  });

  it('(2) BUSY: занятый use case → AppError AI/BUSY до ответа {requestId} (§9)', async () => {
    const useCase = new StubGenerateSummary();
    useCase.busy = true;
    const handler = createAiSummaryGenerateHandler(useCase, new AiSummaryRequestRegistry());

    // Хендлер бросает СИНХРОННО (каркас ловит тем же try/catch → ApiFailure §13).
    let caught: unknown;
    try {
      await handler({ profileId: PROFILE, period: '7d', includeNotes: false });
      expect.unreachable('хендлер обязан отказать AI/BUSY');
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('AI/BUSY');
    expect(useCase.commands).toHaveLength(0);
  });

  it('(3) сбой фонового execute — хендлер не роняет main, код в логе без текста', async () => {
    const useCase = new StubGenerateSummary();
    // Контракт ошибок TASK-006: наружу из use case — только AppError.
    useCase.failure = AppError.of('AI/WORKER_CRASHED', 'errors.AI_WORKER_CRASHED', {
      reason: 'test',
    });
    const { lines, logger } = recordingLogger();
    const handler = createAiSummaryGenerateHandler(useCase, new AiSummaryRequestRegistry(), logger);

    const response = await handler({ profileId: PROFILE, period: '7d', includeNotes: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // микрофоны фонового отказа

    expect(typeof response.requestId).toBe('string');
    const errorLine = lines.find((line) => line.message === 'ai/summary/generate failed');
    expect(errorLine?.meta?.['code']).toBe('AI/WORKER_CRASHED');
  });
});

describe('ai/cancel — хендлер (TASK-087 §5 п.5)', () => {
  it('(4) abort активного requestId → {cancelled: true}, сигнал в команде use case', async () => {
    const useCase = new StubGenerateSummary();
    const registry = new AiSummaryRequestRegistry();
    const generate = createAiSummaryGenerateHandler(useCase, registry);
    const cancel = createAiSummaryCancelHandler(registry);

    const { requestId } = await generate({ profileId: PROFILE, period: '7d', includeNotes: false });
    expect(await cancel({ requestId })).toEqual({ cancelled: true });
    // Сигнал дошёл: команда use case несёт aborted signal.
    const signal = useCase.commands[0]?.signal;
    expect(signal?.aborted).toBe(true);
    useCase.settleAll();
  });

  it('(5) незнакомый/повторный requestId → {cancelled: false} без ошибки (идемпотентность §13)', async () => {
    const registry = new AiSummaryRequestRegistry();
    const cancel = createAiSummaryCancelHandler(registry);
    expect(await cancel({ requestId: 'ghost' })).toEqual({ cancelled: false });
    expect(await cancel({ requestId: 'ghost' })).toEqual({ cancelled: false });
  });
});

describe('ai/summary/latest — хендлер стейлс-бейджа (TASK-087 §12)', () => {
  it('(6) нет записи → undefined; есть → {summary: DTO, stale} по data_version (§7)', async () => {
    const repo = new FakeRepo();
    const handler = createAiSummaryLatestHandler(repo, CLOCK);

    expect(await handler({ profileId: PROFILE, period: '7d' })).toBeUndefined();

    repo.record = {
      id: 's-1',
      profileId: PROFILE,
      period: { fromUtcMs: NOW_MS - 7 * 86_400_000, toUtcMs: NOW_MS },
      contextHash: 'a'.repeat(64),
      modelId: 'm',
      modelVersion: '1',
      dataVersion: 1,
      contentMd: 'Разбор',
      disclaimerText: AI_SUMMARY_DISCLAIMER_TEXT,
      periodText: 'последние 7 дней',
      createdAtUtc: NOW_MS - 1000,
    };
    expect(await handler({ profileId: PROFILE, period: '7d' })).toEqual({
      summary: {
        id: 's-1',
        periodStartUtc: NOW_MS - 7 * 86_400_000,
        periodEndUtc: NOW_MS,
        modelId: 'm',
        modelVersion: '1',
        dataVersion: 1,
        contentMd: 'Разбор',
        disclaimerText: AI_SUMMARY_DISCLAIMER_TEXT,
        periodText: 'последние 7 дней',
        createdAtUtc: NOW_MS - 1000,
      },
      stale: false,
    });

    // «Мутация данных»: текущий data_version вырос — бейдж stale=true (§20 п.3 unit).
    repo.currentVersion = 2;
    const stale = await handler({ profileId: PROFILE, period: '7d' });
    expect(stale).toMatchObject({ stale: true });
  });
});
