/**
 * Хендлеры каналов журнала измерений (TASK-029 §5/§9/§11: `measurements/add`;
 * list/update/delete — TASK-030/037 по мере появления). Слой тонкий: zod-валидацию
 * запроса делает каркас TASK-008 до вызова хендлера, здесь — только вызов use case'а
 * и маппинг Result → контракт канала:
 *  - ok  → MeasurementAddResponse (флаги без «пустых» ключей — чистая форма по проводам);
 *  - err → AppError бросается наружу: каркас ловит его и возвращает ApiFailure(toDto)
 *    (register-channel §13 п. 3–4) — «Result→ApiResult маппинг» выполняется каркасом,
 *    хендлер не строит конверт вручную.
 *
 * Payload — MeasurementAddRequest схемы TASK-028: поля структурно совпадают с
 * CreateMeasurementCommand домена (TASK-017), числа границ синхронизированы
 * контракт-тестом contracts-sync (§19 TASK-028).
 */
import { isErr } from '@hl/kernel';
import type { MeasurementAddRequest, MeasurementAddResponse } from '@hl/contracts';

import { type AddResult, AddMeasurementUseCase } from '../../modules/measurement/application/add-measurement.js';

/** Ответ add (§11): {measurement, flags} — typo/criticalValue включаются только при наличии. */
function toAddResponse(add: AddResult): MeasurementAddResponse {
  return {
    measurement: add.measurement,
    flags: {
      ...(add.flags.typo !== undefined ? { typo: add.flags.typo } : {}),
      duplicate: add.flags.duplicate,
      ...(add.flags.criticalValue !== undefined
        ? { criticalValue: add.flags.criticalValue }
        : {}),
    },
  };
}

/** Фабрика хендлера `measurements/add`: use case инъекцируется контейнером (TASK-027). */
export function createAddMeasurementHandler(
  useCase: AddMeasurementUseCase,
): (payload: MeasurementAddRequest) => Promise<MeasurementAddResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    if (isErr(result)) {
      // Ошибка уходит значением → исключением ровно на границе каркаса, где ей
      // место: AppError → {ok:false, error:toDto} (NFR-12, TASK-008 §13 п. 3).
      throw result.error;
    }
    return toAddResponse(result.value);
  };
}
