/**
 * Хендлеры каналов резюме (TASK-087 §5/§11/§12) — слой тонкий, прецедент
 * ai-context.ts/ai-models.ts: zod-валидацию делает каркас TASK-008 до вызова.
 *
 * `ai/summary/generate` (§5/§11): arch. 05 §3 «стриминг — генерации не держат
 * открытый вызов IPC»: хендлер проверяет слот use case (BUSY → AppError наружу
 * = ApiFailure, §9), генерирует requestId (ключ корреляции ai:token/финала),
 * стартует execute В ФОНЕ (отказ — лог с кодом, без текста: контекст/ответ PHI,
 * §14; UI живёт по событиям ai:status) и мгновенно отвечает {requestId}.
 * Отмена — `ai/cancel` {requestId} → abort сигнала команды (реестр контроллеров
 * общий с generate; незнакомый id — {cancelled: false}, идемпотентность §13 076).
 *
 * `ai/summary/latest` (§12): границы периода — resolveSummaryPeriod (ТОТ ЖЕ код,
 * что у use case: без дрейфа пресетов/сентинелов), чтение latest + stale-флаг
 * (data_version записи против текущего, §7) — бейдж рендерер получает готовым.
 *
 * PHI (§14): requestId/summaryId — идентификаторы (события/лог), текст контекста и
 * ответа в лог не пишется; DTO latest содержит contentMd — только владельцу в ответе.
 */
import { performance } from 'node:perf_hooks';

import type {
  AiCancelRequest,
  AiCancelResponse,
  AiSummaryDto,
  AiSummaryGenerateRequest,
  AiSummaryGenerateResponse,
  AiSummaryLatestRequest,
  AiSummaryLatestResponse,
} from '@hl/contracts';
import { AppError, type Clock } from '@hl/kernel';

import type {
  GenerateSummary,
  GenerateSummaryCommand,
} from '../../modules/ai-insight/application/generate-summary.js';
import { llmEngineBusyError } from '../../modules/ai-insight/application/ports/llm-engine.js';
import type {
  InsightRepository,
  SummaryRecord,
} from '../../modules/ai-insight/application/ports/insight-repository.js';
import { resolveSummaryPeriod } from '../../modules/ai-insight/application/generate-summary.js';

/** Минимальная поверхность логгера хендлеров (§18; HlLogger ей удовлетворяет). */
export interface AiSummaryHandlerLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Реестр активных запросов генерации (§5 п.5): requestId → AbortController.
 * Общий для хендлеров generate и cancel (одна фабрика-класс, проводка контейнером);
 * контроллер снимается с реестра при финале use case (успех/отказ — финализация).
 */
export class AiSummaryRequestRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Зарегистрировать новый запрос (generate). */
  register(requestId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  /** Отменить запрос; незнакомый — false (идемпотентность §13). */
  abort(requestId: string): boolean {
    const controller = this.controllers.get(requestId);
    if (controller === undefined) {
      return false;
    }
    controller.abort();
    this.controllers.delete(requestId);
    return true;
  }

  /** Снять запрос с учёта (финал use case — успех или отказ). */
  release(requestId: string): void {
    this.controllers.delete(requestId);
  }
}

/** Счётчик requestId хендлера (модульный — уникален в пределах процесса main). */
let globalRequestIdCounter = 0;

/** Генератор requestId (§11): префикс домена + счётчик — читаем в логе, без крипто-нужды. */
export function createRequestId(): string {
  globalRequestIdCounter += 1;
  return `ai-summary-${String(globalRequestIdCounter)}`;
}

/** Фабрика хендлера `ai/summary/generate` (§5/§11): быстрый {requestId}, генерация — в фоне. */
export function createAiSummaryGenerateHandler(
  generate: GenerateSummary,
  registry: AiSummaryRequestRegistry,
  logger?: AiSummaryHandlerLogger,
  requestIdGenerator: () => string = createRequestId,
): (payload: AiSummaryGenerateRequest) => Promise<AiSummaryGenerateResponse> {
  return (payload) => {
    // §9 BUSY: синхронная проверка слота ДО ответа — второй generate получает
    // честный ApiFailure AI/BUSY (UI показывает «генерация уже идёт»).
    if (generate.isBusy()) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок канала — AppError (TASK-006; каркас конвертирует в ApiFailure)
      throw llmEngineBusyError();
    }
    const requestId = requestIdGenerator();
    const startedAtMs = performance.now();
    const controller = registry.register(requestId);
    const command: GenerateSummaryCommand = {
      profileId: payload.profileId,
      period: payload.period,
      includeNotes: payload.includeNotes,
      requestId,
      signal: controller.signal,
    };
    // Фоновый запуск (arch. 05 §3): отказ не роняет main и не теряется — лог с кодом
    // (AppError.code — не PHI); события стрима/финала — забота use case (§11).
    void generate.execute(command).catch((error: unknown) => {
      registry.release(requestId);
      const code = error instanceof AppError ? error.code : 'APP/INTERNAL';
      logger?.warn('ai/summary/generate failed', {
        requestId,
        code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
    });
    return Promise.resolve({ requestId });
  };
}

/** Фабрика хендлера `ai/cancel` (§5 п.5): abort активного запроса по requestId. */
export function createAiSummaryCancelHandler(
  registry: AiSummaryRequestRegistry,
): (payload: AiCancelRequest) => Promise<AiCancelResponse> {
  return ({ requestId }) => Promise.resolve({ cancelled: registry.abort(requestId) });
}

/** Запись порта → проводной DTO (§7/§12): без contextHash (внутренний кэш-ключ). */
function toDto(record: SummaryRecord): AiSummaryDto {
  return {
    id: record.id,
    periodStartUtc: record.period.fromUtcMs,
    periodEndUtc: record.period.toUtcMs,
    modelId: record.modelId,
    modelVersion: record.modelVersion,
    dataVersion: record.dataVersion,
    contentMd: record.contentMd,
    disclaimerText: record.disclaimerText,
    periodText: record.periodText,
    createdAtUtc: record.createdAtUtc,
  };
}

/** Фабрика хендлера `ai/summary/latest` (§12): latest по периоду + готовый stale-флаг. */
export function createAiSummaryLatestHandler(
  repo: InsightRepository,
  clock: Clock,
): (payload: AiSummaryLatestRequest) => Promise<AiSummaryLatestResponse> {
  return async ({ profileId, period }) => {
    // ТЕ ЖЕ правила границ, что у use case (§12: без дрейфа пресетов/сентинелов).
    const resolved = resolveSummaryPeriod(period, clock);
    const record = await repo.latestForPeriod(profileId, resolved.period);
    if (record === undefined) {
      return undefined;
    }
    const stale = record.dataVersion < (await repo.currentDataVersion());
    return { summary: toDto(record), stale };
  };
}
