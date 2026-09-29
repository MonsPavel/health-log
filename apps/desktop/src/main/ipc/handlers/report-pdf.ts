/**
 * Хендлер канала `report/pdf` (TASK-068 §5/§11) — слой тонкий, прецедент report.ts
 * (TASK-065): zod-валидацию запроса делает каркас TASK-008 до вызова хендлера;
 * здесь — вызов use case BuildPdfReport (сборка payload → пул → очередь → saver)
 * и маппинг Result → контракт:
 *  - ok {pages, durationMs, file} → ответ канала — file ({path} | {canceled: true},
 *    §7: отмена — НЕ ошибка, конверт ok);
 *  - err (REPORT/EMPTY_PERIOD | REPORT/RENDER_FAILED | EXPORT/FAILED) → AppError
 *    бросается наружу: каркас ловит его и возвращает ApiFailure(toDto)
 *    (register-channel §13 п. 3–4, прецедент measurements.ts).
 */
import { isErr, type AppError, type Result } from '@hl/kernel';

import type { ReportPdfRequest, ReportPdfResponse } from '@hl/contracts';

import type {
  BuildPdfReportUseCase,
  BuildPdfReportValue,
} from '../../modules/reporting/application/build-pdf-report.js';

/**
 * Фабрика хендлера `report/pdf`: use case инъекцируется контейнером (TASK-027).
 * Ответ — {path} | {canceled: true} по union-схеме экспорта (§11, переиспользование).
 */
export function createBuildPdfReportHandler(
  useCase: BuildPdfReportUseCase,
): (payload: ReportPdfRequest) => Promise<ReportPdfResponse> {
  return async (payload) => unwrap(useCase.execute(payload));
}

/** Result → file-часть значения; err — исключением ровно на границе каркаса (§13 п. 3). */
async function unwrap(
  result: Promise<Result<BuildPdfReportValue, AppError>>,
): Promise<ReportPdfResponse> {
  const resolved = await result;
  if (isErr(resolved)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9; каркас конвертирует в ApiFailure(toDto), прецедент report.ts)
    throw resolved.error;
  }
  return resolved.value.file;
}
