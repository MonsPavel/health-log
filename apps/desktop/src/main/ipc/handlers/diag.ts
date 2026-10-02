/**
 * Хендлеры каналов диагностического пакета `diag/*` (TASK-103 §11) — слой тонкий,
 * прецедент privacy.ts: zod-валидацию запроса делает каркас TASK-008 до вызова
 * хендлера; здесь — вызов DiagBundleService. diag/preview — сборка для
 * предпросмотра (AC §20-3); diag/save — outcome сервиса в union канала
 * ({path} | {canceled: true}, §7 065 — отмена диалога не ошибка).
 */
import type { DiagPreviewRequest, DiagPreviewResponse, DiagSaveRequest, DiagSaveResponse } from '@hl/contracts';

import type { DiagBundleService } from '../../modules/platform-services/diag/diag-service.js';

/** Фабрика хендлера `diag/preview` (§11): сборка содержимого пакета в памяти main. */
export function createDiagPreviewHandler(
  service: DiagBundleService,
): (payload: DiagPreviewRequest) => Promise<DiagPreviewResponse> {
  return () => service.collect();
}

/** Фабрика хендлера `diag/save` (§11): zip → save-диалог → move; исход — union 065. */
export function createDiagSaveHandler(
  service: DiagBundleService,
): (payload: DiagSaveRequest) => Promise<DiagSaveResponse> {
  return async () => {
    const outcome = await service.saveBundle();
    return outcome.saved ? { path: outcome.path } : { canceled: true };
  };
}
