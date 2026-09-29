/**
 * Хендлеры каналов экспорта `report/export-csv|export-json` (TASK-065 §5/§11) —
 * слой тонкий, прецедент measurements.ts: zod-валидацию запроса делает каркас
 * TASK-008 до вызова хендлера; здесь — вызов use case файлового экспорта
 * (оркестрация: очередь → генерация 063/064 → saver) и маппинг Result → контракт:
 *  - ok {path} | {canceled: true} → ответ канала по схеме report (§7: отмена —
 *    НЕ ошибка, конверт ok);
 *  - err → AppError бросается наружу: каркас ловит его и возвращает
 *    ApiFailure(toDto) (register-channel §13 п. 3–4) — EXPORT/FAILED.
 *
 * ТЕЛЕМЕТРИЯ (§18): `export csv|json path-basename=… count=… durationMs` — в самом
 * оркестраторе (basename известен после записи; полный путь в лог не идёт — §14).
 * Отмена — без записи лога успеха (ожидаемый исход, §7).
 */
import { isErr, type AppError, type Result } from '@hl/kernel';

import type { ReportExportRequest, ReportExportResponse } from '@hl/contracts';

import type { ExportCsvFileUseCase } from '../../modules/reporting/application/export-csv-file.js';
import type { ExportJsonFileUseCase } from '../../modules/reporting/application/export-json-file.js';

/**
 * Фабрика хендлера `report/export-csv`: use case инъекцируется контейнером (TASK-027).
 * Ответ — {path} | {canceled: true} по строгой схеме TASK-065 (§11).
 */
export function createExportCsvHandler(
  useCase: ExportCsvFileUseCase,
): (payload: ReportExportRequest) => Promise<ReportExportResponse> {
  return async (payload) => unwrap(useCase.execute(payload.profileId));
}

/** Фабрика хендлера `report/export-json` (§5 «аналогично»): тот же контракт ответа. */
export function createExportJsonHandler(
  useCase: ExportJsonFileUseCase,
): (payload: ReportExportRequest) => Promise<ReportExportResponse> {
  return async (payload) => unwrap(useCase.execute(payload.profileId));
}

/** Result → ответ канала; err — исключением ровно на границе каркаса (§13 п. 3). */
async function unwrap(
  result: Promise<Result<ReportExportResponse, AppError>>,
): Promise<ReportExportResponse> {
  const resolved = await result;
  if (isErr(resolved)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9; каркас конвертирует в ApiFailure(toDto), прецедент measurements.ts)
    throw resolved.error;
  }
  return resolved.value;
}
