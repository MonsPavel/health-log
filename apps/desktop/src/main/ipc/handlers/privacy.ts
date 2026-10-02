/**
 * Хендлеры каналов экрана «Приватность» `privacy/*` (TASK-098 §11) — слой тонкий,
 * прецедент updates.ts: zod-валидацию запроса делает каркас TASK-008 до вызова
 * хендлера; здесь — вызов PrivacyQueries. Ошибки каналов — только валидационные
 * (§11): строгий patch отсекается схемой каркаса ещё ДО хендлера (VALIDATION/FAILED,
 * §14), отказ записи prefs — STORAGE/* сервиса наверх.
 */
import type {
  Consents,
  PrivacyConsentsRequest,
  PrivacyJournalRequest,
  PrivacyJournalResponse,
} from '@hl/contracts';

import type { PrivacyQueries } from '../../modules/platform-services/application/privacy-queries.js';

/** Фабрика хендлера `privacy/journal` (§11): агрегация журнала и операций политики. */
export function createPrivacyJournalHandler(
  queries: PrivacyQueries,
): (payload: PrivacyJournalRequest) => Promise<PrivacyJournalResponse> {
  return (payload) => queries.journal(payload.limit);
}

/**
 * Фабрика хендлера `privacy/consents` (§5/§11): {} — чтение, {patch} —
 * переключение (единый канал изменения согласий, §14).
 */
export function createPrivacyConsentsHandler(
  queries: PrivacyQueries,
): (payload: PrivacyConsentsRequest) => Promise<Consents> {
  return async (payload) =>
    payload.patch === undefined ? queries.getConsents() : queries.patchConsents(payload.patch);
}
