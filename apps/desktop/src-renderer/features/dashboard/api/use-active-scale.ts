/**
 * TASK-057 §5/§11: api-слой активной шкалы — useQuery поверх канала
 * `scales/active` (TASK-051). Шкала нужна графику для опорных линий (§5 057:
 * пороги high_normal/hypertension1 — ИЗ ДАННЫХ шкалы, не хардкод) и подписи
 * источника (sourceLabel из данных, §17).
 *
 * КЛЮЧ: ['scales', 'active'] — канал маленький и статический между запусками
 * (§11 051), staleTime Infinity — инвалидация не нужна в MVP (событие
 * scales:changed — не в MVP, §5 051).
 *
 * Конверт разворачивается: ok:false → IpcApiError (STORAGE/CORRUPT повреждённой
 * шкалы — §7 051; отказ чтения данные, не технический краш).
 */
import { useQuery } from '@tanstack/react-query';

import type { ActiveScale } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../../measurement/api/use-add-measurement';

/** Ключ запроса активной шкалы (§11 051): один канал на окно. */
export const ACTIVE_SCALE_KEY = ['scales', 'active'] as const;

/** Вызов канала scales/active: разворот конверта; failure → IpcApiError (§11). */
async function fetchActiveScale(): Promise<ActiveScale> {
  const result = await call('scales/active', {});
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Хук активной шкалы (§5): scales/active {} → ActiveScale; staleTime Infinity (§11 051). */
export function useActiveScale() {
  return useQuery({
    queryKey: ACTIVE_SCALE_KEY,
    queryFn: fetchActiveScale,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
