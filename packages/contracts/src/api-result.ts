/**
 * TASK-008 §5: конверт ответа всех IPC-каналов (арх. 05 §2). Ошибки никогда не
 * пересекают границу как исключения/стеки (NFR-12) — только как данные
 * `{ok:false, error: AppErrorDto}`. Поле v — версия схемы контракта (арх. 05 §6):
 * изменение формы конверта без смены v запрещено.
 */
import type { AppErrorDto } from './app-error-dto.js';

/** Версия схемы конверта (арх. 05 §6): с первого дня, чтобы формат не менялся под грузом фич. */
export const API_ENVELOPE_VERSION = 1;

/** Успешная ветка ответа канала. */
export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

/** Ошибочная ветка ответа канала. */
export interface ApiFailure {
  readonly ok: false;
  readonly error: AppErrorDto;
}

/** Результат IPC-вызова для рендерера (арх. 05 §2). */
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** Конверт поверх результата: `{v: 1, ...result}` (§11). */
export type ApiEnvelope<T> = { readonly v: typeof API_ENVELOPE_VERSION } & ApiResult<T>;

/** Успешный конверт (каркас main заворачивает результат хендлера, §13 п. 3). */
export function apiSuccess<T>(data: T): ApiEnvelope<T> {
  return { v: API_ENVELOPE_VERSION, ok: true, data };
}

/** Ошибочный конверт с DTO ошибки. */
export function apiFailure(error: AppErrorDto): ApiEnvelope<never> {
  return { v: API_ENVELOPE_VERSION, ok: false, error };
}

/**
 * Type guard формы конверта на недоверенной границе: рендерер проверяет ответ
 * моста перед использованием (повреждённый/чужой ответ не должен пройти как данные).
 */
export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly v?: unknown; readonly ok?: unknown };
  return candidate.v === API_ENVELOPE_VERSION && (candidate.ok === true || candidate.ok === false);
}
