/**
 * Хендлер канала `measurements/delete` (TASK-032 §5/§9/§11 — реализация схемы
 * TASK-028; TASK-037 позже добавит к use case'у full-edit). Файл отдельный по §6,
 * слой тот же тонкий: zod-валидацию запроса делает каркас TASK-008 до вызова
 * хендлера, здесь — только вызов use case'а и маппинг Result → контракт канала:
 *  - ok  → ответ канала {deleted: true} по строгой схеме TASK-028;
 *  - err → AppError бросается наружу: каркас ловит его и возвращает ApiFailure(toDto)
 *    (register-channel §13 п. 3–4, прецедент measurements.ts). MEASUREMENT/NOT_FOUND
 *    проходит как есть — рендерер покажет тост «уже удалена», не краш (§7/§13).
 */
import { isErr } from '@hl/kernel';
import type { MeasurementDeleteRequest, MeasurementDeleteResponse } from '@hl/contracts';

import { DeleteMeasurementUseCase } from '../../modules/measurement/application/delete-measurement.js';

/** Фабрика хендлера `measurements/delete`: use case инъекцируется контейнером (TASK-027). */
export function createDeleteMeasurementHandler(
  useCase: DeleteMeasurementUseCase,
): (payload: MeasurementDeleteRequest) => Promise<MeasurementDeleteResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    if (isErr(result)) {
      // Ошибка уходит значением → исключением ровно на границе каркаса, где ей
      // место: AppError → {ok:false, error:toDto} (NFR-12, TASK-008 §13 п. 3).
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9; каркас register-channel конвертирует его в ApiFailure(toDto), прецедент measurements.ts)
      throw result.error;
    }
    // §7: DeleteResult = {deleted: true} — форма ответа канала TASK-028.
    return result.value;
  };
}
