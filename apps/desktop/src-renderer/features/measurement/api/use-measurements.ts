/**
 * TASK-033 §5/§11/§12: api-слой истории — useInfiniteQuery поверх канала
 * `measurements/list` (TASK-030).
 *
 * КЛЮЧ (§12): ['measurements', profileId, {limit:200, …фильтры}] — префикс
 * ['measurements'] общий с инвалидациями мутаций add/delete/update
 * (TASK-031/032/037) и событием measurement:changed (TASK-009); фильтры
 * TASK-044 входят в третий элемент — разные фильтры не конфликтуют в кэше,
 * смена фильтра = новый ключ = fetch (§10), прежний результат остаётся в кэше
 * (быстрый возврат). Частичный ключ инвалидаций ['measurements', profileId]
 * матчит все варианты фильтров (prefix-matching TanStack).
 *
 * placeholderData: keepPreviousData (§10/§15 «смена фильтра — мгновенная»):
 * пока загружается страница с новыми фильтрами, показан предыдущий список, и
 * панель фильтров не размонтируется (§16 — фокус остаётся на контроле).
 *
 * Страница — offset-пагинация TanStack (fetchNextPage, §10): pageParam = offset,
 * следующий offset = сколько уже загружено; hasNextPage = загружено < total
 * (total считает ВСЕ подходящие записи без пагинации — TASK-030 §7, подпись
 * «Показано N из M» точна). staleTime Infinity — из дефолтов QueryClient
 * (lib/query-client, §12: данные всегда «свежие после инвалидации»).
 *
 * Конверт разворачивается: ok:false → IpcApiError c AppErrorDto (прецедент
 * use-add-measurement — отказ чтения данные, не технический краш).
 */
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import type { MeasurementListRequest, MeasurementListResponse } from '@hl/contracts';

import type { MeasurementQueryFragment } from '../model/filters';
import { call } from '../../../src/lib/ipc';
import { IpcApiError } from './use-add-measurement';

/** Размер страницы истории (§5): дефолт канала list — 200 записей. */
export const HISTORY_PAGE_LIMIT = 200;

/** Ключ запроса истории (§12); корень 'measurements' — точка инвалидаций; фильтры — в третьем элементе. */
export function measurementsKey(
  profileId: string,
  filters?: MeasurementQueryFragment,
): readonly ['measurements', string, MeasurementListRequest] {
  return ['measurements', profileId, { limit: HISTORY_PAGE_LIMIT, ...(filters ?? {}) }];
}

/** Вызов канала list: разворот конверта; failure → IpcApiError (§11). */
async function listMeasurements(request: MeasurementListRequest): Promise<MeasurementListResponse> {
  const result = await call('measurements/list', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Хук истории (§5): страницы по {limit:200}, offset растёт на загруженное; фильтры (TASK-044) — в ключе и payload. */
export function useMeasurements(profileId: string, filters?: MeasurementQueryFragment) {
  return useInfiniteQuery({
    queryKey: measurementsKey(profileId, filters),
    queryFn: ({ pageParam }) =>
      listMeasurements({ profileId, limit: HISTORY_PAGE_LIMIT, offset: pageParam, ...(filters ?? {}) }),
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });
}

