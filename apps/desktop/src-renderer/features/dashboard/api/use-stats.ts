/**
 * TASK-059 §5/§11/§12: api-слой статистики периода — useQuery поверх канала
 * `stats/period` (TASK-054). Хук вынесен сюда из 061-плана (§6): резюме тренда
 * (TrendSummary) и aria-резюме графика потребляют ТЕ ЖЕ числа stats-ответа, что
 * и будущий дашборд 061 — переиспользование данных, не дублирование вычислений
 * (§5/§13: «резюме-числа == числа таблицы == числа графика — одни read models»).
 *
 * КЛЮЧ (§12): ['stats', profileId, period] — период в третьем элементе (разные
 * периоды не конфликтуют в кэше), префикс ['stats'] (STATS_KEY_ROOT) — точка
 * инвалидаций по событию measurement:changed (§10, прецедент ['trend'] 057).
 *
 * placeholderData: keepPreviousData — смена периода держит прежний ответ до
 * прихода нового (§15, прецедент use-trend). STALETIME 0 — то же осознанное
 * отступление от дефолта клиента, что у use-trend (e2e-находка 057): экран — не
 * место ввода, подписка на событие живёт при смонтированном экране, кэш обязан
 * быть вечно свеж при возврате → перечитывание на каждом монтировании (IPC ≈2 мс).
 *
 * Конверт разворачивается: ok:false → IpcApiError c dto отказа (прецедент
 * use-trend — отказ чтения данные, не технический краш).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type { StatsPeriodParam, StatsRequest, StatsResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../../measurement/api/use-add-measurement';

/** Корень ключей статистики (§12): точка инвалидаций по событию measurement:changed. */
export const STATS_KEY_ROOT = ['stats'] as const;

/** Ключ запроса статистики (§12): профиль + период канала (пресет или custom-границы). */
export function statsKey(
  profileId: string,
  period: StatsPeriodParam,
): readonly ['stats', string, StatsPeriodParam] {
  return ['stats', profileId, period];
}

/** Вызов канала stats/period: разворот конверта; failure → IpcApiError (§11). */
async function fetchStats(request: StatsRequest): Promise<StatsResponse> {
  const result = await call('stats/period', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Хук статистики периода (§5): stats/period {profileId, period} → StatsResponse. */
export function useStats(profileId: string, period: StatsPeriodParam) {
  return useQuery({
    queryKey: statsKey(profileId, period),
    queryFn: () => fetchStats({ profileId, period }),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}
