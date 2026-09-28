/**
 * Хендлер канала `trend/series` (TASK-056 §5/§11/§18): слой тонкий, прецедент
 * stats.ts — zod-валидацию запроса делает каркас TASK-008 до вызова хендлера,
 * здесь — вызов read model TrendSeries и замер длительности (§18):
 * `trend/series period=… mode=raw points=N durationMs=…`. points — число элементов
 * ответа (сырых точек в raw, дней в daily — агрегат, не PHI, §18); period пишется
 * пресетом или 'custom' (границы custom — шум). Отказов домена нет (§9): STORAGE/*
 * пробрасывается портом выше — каркас вернёт ApiFailure(toDto); пустой период —
 * валидный ответ {mode:'raw', points:[]} (§11).
 */
import { performance } from 'node:perf_hooks';

import type { TrendRequest, TrendResponse } from '@hl/contracts';

import type { TrendSeries } from '../../modules/analytics/application/trend-series.js';

/** Минимальная поверхность логгера хендлера (§18; HlLogger ей удовлетворяет). */
export interface TrendHandlerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Метка периода для лога (§18): пресет как есть, custom — без границ. */
function periodLabel(period: TrendRequest['period']): string {
  return typeof period === 'string' ? period : 'custom';
}

/**
 * Фабрика хендлера `trend/series`: read model и логгер инъекцируются контейнером
 * (TASK-027). Ответ — {mode, points?|days?} по строгой схеме TASK-056 (§11).
 */
export function createTrendSeriesHandler(
  useCase: TrendSeries,
  logger?: TrendHandlerLogger,
): (payload: TrendRequest) => Promise<TrendResponse> {
  return async (payload) => {
    const startedAtMs = performance.now();
    const response = await useCase.getTrendSeries(payload.profileId, payload.period);
    logger?.info('trend/series', {
      period: periodLabel(payload.period),
      mode: response.mode,
      points: response.mode === 'raw' ? (response.points?.length ?? 0) : (response.days?.length ?? 0),
      durationMs: Math.round(performance.now() - startedAtMs),
    });
    return response;
  };
}
