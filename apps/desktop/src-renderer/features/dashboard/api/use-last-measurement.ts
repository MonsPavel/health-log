/**
 * TASK-061 §5/§11/§12: api-слой «последней записи» сводки — useQuery поверх
 * канала `measurements/list` с limit 1 (список отсортирован takenAtUtc DESC,
 * id DESC — TASK-030: первая строка и есть последняя запись; §4 — никаких новых
 * каналов и вычислений, потребление готового).
 *
 * КЛЮЧ (§12): ['measurements', profileId, 'last'] — корень ['measurements']
 * общий с инвалидациями мутаций (TASK-031/032/037) и событием
 * measurement:changed (частичный ключ ['measurements', profileId] матчит и
 * страницы журнала, и «последнюю» — сводка живая). Третьи элементы не
 * конфликтуют: у журнала — объект фильтров, у сводки — литерал 'last'.
 *
 * STALETIME 0 — то же осознанное отступление от дефолта клиента, что у
 * use-stats/use-trend: экран — не место ввода, подписка на событие живёт при
 * смонтированном экране, кэш обязан быть вечно свеж при возврате (IPC ≈2 мс).
 *
 * Конверт разворачивается: ok:false → IpcApiError c dto отказа (прецедент
 * use-stats — отказ чтения данные, не технический краш).
 */
import { useQuery } from '@tanstack/react-query';

import type { MeasurementListResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../../measurement/api/use-add-measurement';

/** Ключ запроса «последняя запись» (§12): корень общий с журналом, литерал 'last'. */
export function lastMeasurementKey(profileId: string): readonly ['measurements', string, 'last'] {
  return ['measurements', profileId, 'last'];
}

/** Вызов канала list c limit 1: разворот конверта; failure → IpcApiError (§11). */
async function fetchLastMeasurement(profileId: string): Promise<MeasurementListResponse> {
  const result = await call('measurements/list', { profileId, limit: 1, offset: 0 });
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/**
 * Хук «последняя запись» (§5): measurements/list {limit:1} → {items, total}.
 * items[0] — последняя запись (desc-порядок); total — ВСЕ записи профиля
 * (TASK-030 §7): total === 0 — честный признак пустой БД для welcome-состояния.
 */
export function useLastMeasurement(profileId: string) {
  return useQuery({
    queryKey: lastMeasurementKey(profileId),
    queryFn: () => fetchLastMeasurement(profileId),
    staleTime: 0,
  });
}
