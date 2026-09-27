/**
 * Хендлеры каналов журнала измерений (TASK-029 §5/§9/§11: `measurements/add`;
 * TASK-030 §5/§9/§11: `measurements/list`; update/delete — TASK-037 по мере появления).
 * Слой тонкий: zod-валидацию запроса делает каркас TASK-008 до вызова хендлера, здесь —
 * только вызов use case'а и маппинг Result → контракт канала:
 *  - ok  → ответ канала по строгой схеме TASK-028;
 *  - err → AppError бросается наружу: каркас ловит его и возвращает ApiFailure(toDto)
 *    (register-channel §13 п. 3–4) — «Result→ApiResult маппинг» выполняется каркасом,
 *    хендлер не строит конверт вручную.
 *
 * Payload — схемы TASK-028: поля add структурно совпадают с CreateMeasurementCommand
 * домена (TASK-017), query list — с MeasurementQuery порта (TASK-021); числа границ
 * синхронизированы контракт-тестом contracts-sync (§19 TASK-028). У list доменных
 * отказов нет (§9 TASK-030) — хендлер возвращает страницу значением, только
 * инфраструктурный неуспех дошёл бы до каркаса (APP/INTERNAL).
 */
import { isErr } from '@hl/kernel';
import type {
  MeasurementAddRequest,
  MeasurementAddResponse,
  MeasurementListRequest,
  MeasurementListResponse,
  MeasurementUpdateRequest,
  MeasurementUpdateResponse,
} from '@hl/contracts';

import {
  type AddResult,
  AddMeasurementUseCase,
} from '../../modules/measurement/application/add-measurement.js';
import { ListMeasurementsUseCase } from '../../modules/measurement/application/list-measurements.js';
import { UpdateMeasurementUseCase } from '../../modules/measurement/application/update-measurement.js';

/** Ответ add (§11): {measurement, flags} — typo/criticalValue включаются только при наличии. */
function toAddResponse(add: AddResult): MeasurementAddResponse {
  return {
    measurement: add.measurement,
    flags: {
      ...(add.flags.typo !== undefined ? { typo: add.flags.typo } : {}),
      duplicate: add.flags.duplicate,
      ...(add.flags.criticalValue !== undefined ? { criticalValue: add.flags.criticalValue } : {}),
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
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9; каркас register-channel конвертирует его в ApiFailure(toDto), прецедент container.ts/sqlite.ts)
      throw result.error;
    }
    return toAddResponse(result.value);
  };
}

/**
 * Фабрика хендлера `measurements/list` (TASK-030 §5/§9/§11): use case инъекцируется
 * контейнером (TASK-027). Отказов нет (§9) — страница {items, total} возвращается
 * значением; нормализация limit/offset (дефолты, clamp 500) — внутри use case (§13).
 */
export function createListMeasurementHandler(
  useCase: ListMeasurementsUseCase,
): (payload: MeasurementListRequest) => Promise<MeasurementListResponse> {
  return async (payload) => useCase.execute(payload);
}

/**
 * Фабрика хендлера `measurements/update` (TASK-037 §5/§9/§11): use case инъекцируется
 * контейнером (TASK-027), слой тот же тонкий. Payload — схема TASK-028 {id, …поля},
 * структурно совпадает с UpdateMeasurementCommand use case'а — передаётся как есть.
 * Ответ — {measurement} по строгой схеме TASK-028 (§66 TASK-028: «update → {measurement}»):
 * флаги эвристик результата use case (UpdateResult §7) в провод не идут — их потребитель
 * в main — лог §18; duplicate в ответе отсутствует по построению (решение §5).
 *  - ok  → ответ канала {measurement} по строгой схеме TASK-028;
 *  - err → AppError бросается наружу: каркас ловит его и возвращает ApiFailure(toDto)
 *    (register-channel §13 п. 3–4, прецедент add); NOT_FOUND и FUTURE_TIME проходят
 *    как есть (§22: единые коды CRUD).
 */
export function createUpdateMeasurementHandler(
  useCase: UpdateMeasurementUseCase,
): (payload: MeasurementUpdateRequest) => Promise<MeasurementUpdateResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    if (isErr(result)) {
      // Ошибка уходит значением → исключением ровно на границе каркаса, где ей
      // место: AppError → {ok:false, error:toDto} (NFR-12, TASK-008 §13 п. 3).
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9; каркас register-channel конвертирует его в ApiFailure(toDto), прецедент measurements-delete.ts)
      throw result.error;
    }
    return { measurement: result.value.measurement };
  };
}
