/**
 * TASK-057 §5/§11/§12: api-слой серий графика — useQuery поверх канала
 * `trend/series` (TASK-056). Слоя тонкий: read model main сам решает raw/daily
 * (§2 056 — «переключение режимов — поведение read model, а не забота UI»),
 * рендерер только отдаёт период и рисует ветку по mode.
 *
 * КЛЮЧ (§12): ['trend', profileId, period] — период (StatsPeriodParam, та же
 * схема TASK-054/056) в третьем элементе: разные периоды не конфликтуют в кэше,
 * смена периода = новый ключ = fetch (§10), прежний результат остаётся в кэше
 * (быстрый возврат). Префикс ['trend'] (TREND_KEY_ROOT) — точка инвалидаций по
 * событию measurement:changed (§10: «данные свежие после ввода», прецедент
 * ['measurements'] списка истории).
 *
 * placeholderData: keepPreviousData — смена периода показывает предыдущую серию
 * до прихода новой (§15, прецедент use-measurements).
 *
 * Конверт разворачивается: ok:false → IpcApiError c dto отказа (прецедент
 * use-measurements — отказ чтения данные, не технический краш).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type { StatsPeriodParam, TrendRequest, TrendResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../../measurement/api/use-add-measurement';

/** Корень ключей серий графика (§12): точка инвалидаций по событию measurement:changed. */
export const TREND_KEY_ROOT = ['trend'] as const;

/** Ключ запроса серий (§12): профиль + период канала (пресет или custom-границы). */
export function trendKey(
  profileId: string,
  period: StatsPeriodParam,
): readonly ['trend', string, StatsPeriodParam] {
  return ['trend', profileId, period];
}

/** Вызов канала trend/series: разворот конверта; failure → IpcApiError (§11). */
async function fetchTrendSeries(request: TrendRequest): Promise<TrendResponse> {
  const result = await call('trend/series', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Хук серий графика (§5): trend/series {profileId, period} → TrendResponse. */
export function useTrend(profileId: string, period: StatsPeriodParam) {
  return useQuery({
    queryKey: trendKey(profileId, period),
    queryFn: () => fetchTrendSeries({ profileId, period }),
    placeholderData: keepPreviousData,
  });
}
