/**
 * TASK-032 §11/§12: api-слой удаления — useMutation поверх call('measurements/delete')
 * (реализация канала TASK-028 → TASK-032). Успешный конверт разворачивается, ok:false
 * → IpcApiError с AppErrorDto (прецедент use-add-measurement: NOT_FOUND — данные,
 * не технический краш; форму тоста решает владелец §13).
 *
 * onSuccess — инвалидация ['measurements'] (§12); событие measurement:changed из main
 * дублирует — двойная защита, ок.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  APP_INTERNAL_ERROR,
  type AppErrorDto,
  type MeasurementDeleteRequest,
  type MeasurementDeleteResponse,
} from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from './use-add-measurement';

/** Вызов канала delete: разворот конверта; failure → IpcApiError (§11). */
async function deleteMeasurement(
  request: MeasurementDeleteRequest,
): Promise<MeasurementDeleteResponse> {
  const result = await call('measurements/delete', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Опции хука: результат/ошибка наверх — тост и возврат значений решает форма (§13). */
export interface DeleteMeasurementOptions {
  /** Успех: {deleted: true}. */
  readonly onSuccess?: (result: MeasurementDeleteResponse) => void;
  /** Отказ: dto ошибки (NOT_FOUND — «уже удалена», STORAGE/* — запись на месте). */
  readonly onError?: (error: AppErrorDto) => void;
}

/** Мутация delete: инвалидация ['measurements'] на успехе (§12) + хендлеры наверх. */
export function useDeleteMeasurement(
  options?: DeleteMeasurementOptions,
): ReturnType<typeof useMutation<MeasurementDeleteResponse, Error, MeasurementDeleteRequest>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteMeasurement,
    onSuccess: (data) => {
      // §12: invalidateQueries(['measurements']) + versionBumped-событие придёт из main.
      void queryClient.invalidateQueries({ queryKey: ['measurements'] });
      options?.onSuccess?.(data);
    },
    onError: (error) => {
      // Транспорт/конверт → APP/INTERNAL; отказ домена (NOT_FOUND) → его dto (§10).
      options?.onError?.(error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR);
    },
  });
}
