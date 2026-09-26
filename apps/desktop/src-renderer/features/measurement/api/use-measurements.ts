/**
 * TASK-033 §5/§11/§12: api-слой истории — useInfiniteQuery поверх канала
 * `measurements/list` (TASK-030).
 *
 * КЛЮЧ (§12): ['measurements', profileId, {limit:200}] — префикс ['measurements']
 * общий с инвалидациями мутаций add/delete/update (TASK-031/032/037) и событием
 * measurement:changed (TASK-009); фильтры (TASK-044) добавятся в третий элемент.
 * Страница — offset-пагинация TanStack (fetchNextPage, §10): pageParam = offset,
 * следующий offset = сколько уже загружено; hasNextPage = загружено < total
 * (total считает ВСЕ подходящие записи без пагинации — TASK-030 §7, подпись
 * «Показано N из M» точна). staleTime Infinity — из дефолтов QueryClient
 * (lib/query-client, §12: данные всегда «свежие после инвалидации»).
 *
 * Конверт разворачивается: ok:false → IpcApiError c AppErrorDto (прецедент
 * use-add-measurement — отказ чтения данные, не технический краш).
 */
import { useInfiniteQuery } from '@tanstack/react-query';

import type { MeasurementListRequest, MeasurementListResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from './use-add-measurement';

/** Размер страницы истории (§5): дефолт канала list — 200 записей. */
export const HISTORY_PAGE_LIMIT = 200;

/** Ключ запроса истории (§12); корень 'measurements' — точка инвалидаций. */
export function measurementsKey(
  profileId: string,
): readonly ['measurements', string, { readonly limit: number }] {
  return ['measurements', profileId, { limit: HISTORY_PAGE_LIMIT }];
}

/** Вызов канала list: разворот конверта; failure → IpcApiError (§11). */
async function listMeasurements(request: MeasurementListRequest): Promise<MeasurementListResponse> {
  const result = await call('measurements/list', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Хук истории (§5): страницы по {limit:200}, offset растёт на загруженное. */
export function useMeasurements(profileId: string) {
  return useInfiniteQuery({
    queryKey: measurementsKey(profileId),
    queryFn: ({ pageParam }) =>
      listMeasurements({ profileId, limit: HISTORY_PAGE_LIMIT, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });
}
