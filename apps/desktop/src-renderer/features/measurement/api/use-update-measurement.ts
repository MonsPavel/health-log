/**
 * TASK-038 §4/§11/§12: api-слой правки записи.
 *
 * assembleUpdateRequest — сборка payload `measurements/update` ПОВЕРХ
 * assembleAddRequest (§4 арх. 06: «форма — единственный редактор записи», одна
 * точка валидации/UX; схема update = {id, …поля add}, TASK-028 §120): валидация
 * и сборка takenAt — тот же код, что у add; сверху добавляется id правимой
 * записи. Ошибки — те же FieldErrors (futureTime, rangeSys, required — §13/§20).
 *
 * useUpdateMeasurement — useMutation поверх call('measurements/update')
 * (канал TASK-037: ответ {measurement} по строгой схеме — флаги эвристик в
 * провод не идут, их потребитель в main — лог §18). Успешный конверт
 * разворачивается, ok:false → IpcApiError c AppErrorDto (NOT_FOUND — «запись
 * уже удалена», §13); onSuccess — инвалидация ['measurements'] (§12).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  APP_INTERNAL_ERROR,
  type AppErrorDto,
  type MeasurementUpdateRequest,
  type MeasurementUpdateResponse,
} from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import {
  assembleAddRequest,
  IpcApiError,
  type FieldErrors,
  type MeasurementDraft,
} from './use-add-measurement';

/** Успех сборки update: request с id готов к invoke (валидация zod пройдена). */
export type UpdateAssembledRequest = {
  readonly ok: true;
  readonly request: MeasurementUpdateRequest;
};

/** Отказ сборки update: ошибки полей — ровно те же, что у add (единая точка §4). */
export type UpdateAssembleFailure = { readonly ok: false; readonly fieldErrors: FieldErrors };

/**
 * Сборка + клиентская валидация запроса update (§11/§13): черновик формы
 * валидируется схемой add (§4 — одна точка), к прошедшему запросу добавляется id.
 */
export function assembleUpdateRequest(
  draft: MeasurementDraft,
  id: string,
  nowMs: number,
): UpdateAssembledRequest | UpdateAssembleFailure {
  const result = assembleAddRequest(draft, nowMs);
  if (!result.ok) {
    return result;
  }
  return { ok: true, request: { id, ...result.request } };
}

/** Вызов канала update: разворот конверта; failure → IpcApiError (§11). */
async function updateMeasurement(
  request: MeasurementUpdateRequest,
): Promise<MeasurementUpdateResponse> {
  const result = await call('measurements/update', request);
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Опции хука: результат/ошибка наверх — тосты и сброс формы решает владелец (§13). */
export interface UpdateMeasurementOptions {
  /** Успех: {measurement} — владелец возвращает форму к списку (§5). */
  readonly onSuccess?: (result: MeasurementUpdateResponse) => void;
  /** Отказ: dto ошибки (NOT_FOUND — «уже удалена», FUTURE_TIME — форма остаётся). */
  readonly onError?: (error: AppErrorDto) => void;
}

/** Мутация update: инвалидация ['measurements'] на успехе (§12) + хендлеры наверх. */
export function useUpdateMeasurement(
  options?: UpdateMeasurementOptions,
): ReturnType<typeof useMutation<MeasurementUpdateResponse, Error, MeasurementUpdateRequest>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateMeasurement,
    onSuccess: (data) => {
      // §12: invalidateQueries(['measurements']) + versionBumped-событие придёт из main.
      void queryClient.invalidateQueries({ queryKey: ['measurements'] });
      options?.onSuccess?.(data);
    },
    onError: (error) => {
      // Транспорт/конверт → APP/INTERNAL; отказ домена (NOT_FOUND и др.) → dto (§10).
      options?.onError?.(error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR);
    },
  });
}
