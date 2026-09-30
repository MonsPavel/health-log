/**
 * Хендлеры каналов `ai/models/*` (TASK-081 §5/§9/§11) — слой тонкий, прецедент
 * data-care.ts (TASK-073): zod-валидацию запроса делает каркас TASK-008 до вызова
 * хендлера; здесь — вызов use case AiModelsQueries и маппинг Result → контракт:
 * ok → ответ по схеме канала, err → AppError бросается наружу (каркас конвертирует
 * в ApiFailure(toDto)). download/resume отвечают ФИНАЛОМ флоу 080 (долгий ответ:
 * ход — событиями ai:progress, §11); pause/reset — статус сразу; select —
 * prefs.aiSettings (ensureModel лениво — 087, §9: быстрый UI).
 */
import { isErr } from '@hl/kernel';
import type {
  AiModelsListRequest,
  AiModelsListResponse,
  AiModelsModelIdRequest,
  AiModelsSelectResponse,
  ModelStatusInfo,
} from '@hl/contracts';

import type { AiModelsQueries } from '../../modules/ai-insight/application/models-queries.js';

/** Распаковка Result use case: err → AppError наружу (прецедент data-care.ts). */
function unwrap<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (isErr(result as never)) {
    throw (result as { error: unknown }).error;
  }
  return (result as { value: T }).value;
}

/** Фабрика хендлера `ai/models/list` (§7): витрина + ОЗУ машины + язык UI. */
export function createAiModelsListHandler(
  queries: AiModelsQueries,
): (payload: AiModelsListRequest) => Promise<AiModelsListResponse> {
  return async () => unwrap(await queries.list());
}

/** Фабрика хендлера `ai/models/download` (§5): запуск загрузки, ответ — финал. */
export function createAiModelsDownloadHandler(
  queries: AiModelsQueries,
): (payload: AiModelsModelIdRequest) => Promise<ModelStatusInfo> {
  return async ({ modelId }) => unwrap(await queries.download(modelId));
}

/** Фабрика хендлера `ai/models/pause` (§5): пауза + статус после. */
export function createAiModelsPauseHandler(
  queries: AiModelsQueries,
): (payload: AiModelsModelIdRequest) => Promise<ModelStatusInfo> {
  return async ({ modelId }) => unwrap(await queries.pause(modelId));
}

/** Фабрика хендлера `ai/models/resume` (§5): докачка, ответ — финал. */
export function createAiModelsResumeHandler(
  queries: AiModelsQueries,
): (payload: AiModelsModelIdRequest) => Promise<ModelStatusInfo> {
  return async ({ modelId }) => unwrap(await queries.resume(modelId));
}

/** Фабрика хендлера `ai/models/reset` (§7 080): сброс ошибки, статус после. */
export function createAiModelsResetHandler(
  queries: AiModelsQueries,
): (payload: AiModelsModelIdRequest) => Promise<ModelStatusInfo> {
  return async ({ modelId }) => unwrap(await queries.reset(modelId));
}

/** Фабрика хендлера `ai/models/select` (§5/§9): выбор активной модели (prefs). */
export function createAiModelsSelectHandler(
  queries: AiModelsQueries,
): (payload: AiModelsModelIdRequest) => Promise<AiModelsSelectResponse> {
  return async ({ modelId }) => unwrap(await queries.select(modelId));
}
