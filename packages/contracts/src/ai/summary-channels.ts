/**
 * TASK-087 §5/§11/§12: контракты каналов резюме `ai/summary/*` (UC-03, арх. 05 §3):
 *  - `ai/summary/generate` — {profileId, period, includeNotes} → {requestId} (стрим:
 *    данные идут событиями ai:token/ai:status, финал — событие 'ai/summary/result',
 *    §11; modelId резолвит main из prefs — прецедент ai/context/preview 083);
 *  - `ai/summary/latest` — мини-канал стейлс-бейджа (§12 РЕШЕНИЕ): {profileId,
 *    period} → {summary, stale}|undefined — renderer сравнивает НЕ stats.data_version,
 *    а читает готовый stale-флаг (data_version записи против текущего, §7).
 *
 * Период — переиспользование STATS_PERIOD_PARAM_SCHEMA (§23 054: копии периода не
 * создавать; включено в контракты решением §12). includeNotes участвует в hash кэша
 * (083), поэтому — в запросе generate; latest бейджу заметки не нужны.
 *
 * AiSummaryDto — проводная форма записи §7: content_md (PHI — только владельцу в
 * ответе канала, в лог/события не попадает, §14) + служебные поля disclaimerText/
 * periodText ОТДЕЛЬНО (несъёмный рендер — инвариант §20 п.6: min(1) в схеме —
 * пустое служебное поле запрещено контрактом, замечание §14 «контрактное
 * тест-замечание в DTO»). contextHash — внутренний кэш-ключ, наружу не идёт.
 *
 * Финал 'ai/summary/result' — СОБЫТИЕ карты HlEventMap (events.ts), не канал: генерация
 * не держит открытый вызов IPC (арх. 05 §3 «стриминг»), requestId из ответа generate —
 * ключ корреляции токенов и финала. Имя — дословно §11 (`ai/summary/result`).
 *
 * Все объекты .strict() (§14); типы выводятся из схем (z.infer, §23).
 */
import { z } from 'zod';

import { STATS_PERIOD_PARAM_SCHEMA } from '../stats/schemas.js';

/** §14: профиль-владелец — та же гигиена длины, что у measurement/stats/ai-context (≤64). */
const PROFILE_ID_MAX_LENGTH = 64;

/** §5/§11: запрос generate — {profileId, period, includeNotes} (modelId резолвит main). */
export const AI_SUMMARY_GENERATE_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    period: STATS_PERIOD_PARAM_SCHEMA,
    includeNotes: z.boolean(),
  })
  .strict();

/** §5/§11: ответ generate — {requestId} (финал и стрим — событиями, арх. 05 §3). */
export const AI_SUMMARY_GENERATE_RESPONSE_SCHEMA = z.object({ requestId: z.string().min(1) }).strict();

/** Запрос generate (§11). */
export type AiSummaryGenerateRequest = z.infer<typeof AI_SUMMARY_GENERATE_REQUEST_SCHEMA>;

/** Ответ generate (§11). */
export type AiSummaryGenerateResponse = z.infer<typeof AI_SUMMARY_GENERATE_RESPONSE_SCHEMA>;

/** §12: запрос latest — {profileId, period}. */
export const AI_SUMMARY_LATEST_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    period: STATS_PERIOD_PARAM_SCHEMA,
  })
  .strict();

/** Запрос latest (§12). */
export type AiSummaryLatestRequest = z.infer<typeof AI_SUMMARY_LATEST_REQUEST_SCHEMA>;

/**
 * DTO резюме на проводе (§7): ответ сохранённой генерации. disclaimerText/periodText —
 * min(1) (§20 п.6: заполнены всегда — инвариант закреплён схемой, §14).
 */
export const AI_SUMMARY_DTO_SCHEMA = z
  .object({
    id: z.string().min(1),
    periodStartUtc: z.number().int(),
    periodEndUtc: z.number().int(),
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    dataVersion: z.number().int().nonnegative(),
    contentMd: z.string(),
    disclaimerText: z.string().min(1),
    periodText: z.string().min(1),
    createdAtUtc: z.number().int(),
  })
  .strict();

/** DTO резюме (§7/§12). */
export type AiSummaryDto = z.infer<typeof AI_SUMMARY_DTO_SCHEMA>;

/** Найденное резюме периода + stale-флаг (§12): stale = dataVersion записи < текущего. */
export const AI_SUMMARY_LATEST_FOUND_SCHEMA = z
  .object({
    summary: AI_SUMMARY_DTO_SCHEMA,
    stale: z.boolean(),
  })
  .strict();

/**
 * Ответ latest (§12 дословно {summary, stale}|undefined): undefined — резюме с такими
 * границами периода нет (экран без бейджа; «нет записи» — валидный ответ, не ошибка).
 */
export const AI_SUMMARY_LATEST_RESPONSE_SCHEMA = z.union([
  AI_SUMMARY_LATEST_FOUND_SCHEMA,
  z.undefined(),
]);

/** Ответ latest (§12). */
export type AiSummaryLatestResponse = z.infer<typeof AI_SUMMARY_LATEST_RESPONSE_SCHEMA>;
