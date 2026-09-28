/**
 * Хендлер канала `stats/period` (TASK-054 §5/§11/§18): слой тонкий, прецедент
 * measurements.ts — zod-валидацию запроса делает каркас TASK-008 до вызова хендлера,
 * здесь — вызов use case GetPeriodStatistics и замер длительности (§18):
 * `stats/period period=30d durationMs=… count=…`. count — АГРЕГАТ (не PHI, §18);
 * period в лог пишется пресетом или 'custom' (границы custom — не PHI, но шум).
 * Отказов домена нет (§9): STORAGE/* пробрасывается use case'ом выше — каркас
 * вернёт ApiFailure(toDto); пустой период — валидный ответ с нулями (§11).
 */
import { performance } from 'node:perf_hooks';

import type { StatsRequest, StatsResponse } from '@hl/contracts';

import type { GetPeriodStatistics } from '../../modules/analytics/application/get-period-statistics.js';

/** Минимальная поверхность логгера хендлера (§18; HlLogger ей удовлетворяет). */
export interface StatsHandlerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Метка периода для лога (§18): пресет как есть, custom — без границ. */
function periodLabel(period: StatsRequest['period']): string {
  return typeof period === 'string' ? period : 'custom';
}

/**
 * Фабрика хендлера `stats/period`: use case и логгер инъекцируются контейнером
 * (TASK-027). Ответ — {stats, scale} по строгой схеме TASK-054 (§11).
 */
export function createGetPeriodStatisticsHandler(
  useCase: GetPeriodStatistics,
  logger?: StatsHandlerLogger,
): (payload: StatsRequest) => Promise<StatsResponse> {
  return async (payload) => {
    const startedAtMs = performance.now();
    const response = await useCase.execute(payload);
    logger?.info('stats/period', {
      period: periodLabel(payload.period),
      durationMs: Math.round(performance.now() - startedAtMs),
      count: response.stats.count,
    });
    return response;
  };
}
