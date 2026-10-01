/**
 * TASK-089 §5/§11: контракты каналов чата `ai/chat/*` (UC-19, арх. 05 §3):
 *  - `ai/chat/send` — {profileId, question, period} → {requestId} (стрим:
 *    данные идут событиями ai:token, финал — событие 'ai/chat/result' §11;
 *    modelId резолвит main из prefs — прецедент ai/summary/generate 087);
 *  - `ai/chat/list` — {profileId, limit} → {messages} — инициализация UI
 *    (§12: ключ ['chat', pid], история локальна и очищаема — UC-04);
 *  - `ai/chat/clear` — {} → {cleared: true} — необратимая очистка истории
 *    (§5/§13: clear идемпотентен — всегда успех).
 *
 * Валидация вопроса (§13/§14): zod trim + ≥2 символа ≤500 — «пустой вопрос →
 * VALIDATION» решается схемой каркаса ДО вызова use case; инъекционное
 * накопление ограничено и глубиной истории CHAT_HISTORY_DEPTH=6 (main, §14).
 * profileId в запросе — принудительный скоуп (арх. 08 §3, прецедент 087):
 * таблица chat_message несёт profile_id, история ведётся по профилям.
 *
 * Период — переиспользование STATS_PERIOD_PARAM_SCHEMA (§23 054: копии периода
 * не создавать). ChatMessageDto — проводная форма сообщения истории (§7):
 * content — PHI, наружу только владельцу в ответе канала, в лог/события не
 * попадает (§14); refusalClass — машинный класс отказа (политика 082), у
 * обычных ответов поле отсутствует (в БД NULL, §8).
 *
 * Все объекты .strict() (§14); типы выводятся из схем (z.infer, §23).
 */
import { z } from 'zod';

import { STATS_PERIOD_PARAM_SCHEMA } from '../stats/schemas.js';

/** §14: профиль-владелец — та же гигиена длины, что у measurement/stats/summary (≤64). */
const PROFILE_ID_MAX_LENGTH = 64;

/** §13/§14: минимальная длина вопроса (пустой/односимвольный — VALIDATION). */
const CHAT_QUESTION_MIN_LENGTH = 2;

/** §13/§14: максимальная длина вопроса — гигиена канала (как заметки 017). */
const CHAT_QUESTION_MAX_LENGTH = 500;

/** §11/§12: верхняя граница limit канала list (инициализация UI; гигиена §14). */
const CHAT_LIST_LIMIT_MAX = 200;

/**
 * Машинные классы отказа на проводе (§7): состав политики 082 (RefusalClass);
 * contracts — нижний слой, union повторяет форму политики (единственный источник
 * состава — guardrail-policy main; рассинхрон ловят тесты use case 089).
 */
export const CHAT_REFUSAL_CLASSES = [
  'treatment',
  'dosage',
  'diagnosis',
  'emergency',
  'insufficientData',
] as const;

/** Машинный класс отказа (политика 082) — refusal-ответы истории помечены им (§7). */
export type ChatRefusalClass = (typeof CHAT_REFUSAL_CLASSES)[number];

/** §5/§11: запрос send — {profileId, question, period} (modelId резолвит main). */
export const AI_CHAT_SEND_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    question: z.string().trim().min(CHAT_QUESTION_MIN_LENGTH).max(CHAT_QUESTION_MAX_LENGTH),
    period: STATS_PERIOD_PARAM_SCHEMA,
  })
  .strict();

/** §5/§11: ответ send — {requestId} (стрим/финал — событиями, арх. 05 §3). */
export const AI_CHAT_SEND_RESPONSE_SCHEMA = z
  .object({ requestId: z.string().min(1) })
  .strict();

/** Запрос send (§11). */
export type AiChatSendRequest = z.infer<typeof AI_CHAT_SEND_REQUEST_SCHEMA>;

/** Ответ send (§11). */
export type AiChatSendResponse = z.infer<typeof AI_CHAT_SEND_RESPONSE_SCHEMA>;

/**
 * DTO сообщения истории (§7 дословно): content — PHI (только владельцу, §14);
 * refusalClass опционален — отсутствует у обычных ответов (NULL в БД, §8).
 */
export const CHAT_MESSAGE_DTO_SCHEMA = z
  .object({
    id: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    refusalClass: z.enum(CHAT_REFUSAL_CLASSES).optional(),
    createdAtUtc: z.number().int(),
  })
  .strict();

/** DTO сообщения истории (§7/§12). */
export type ChatMessageDto = z.infer<typeof CHAT_MESSAGE_DTO_SCHEMA>;

/** §5/§11: запрос list — {profileId, limit}. */
export const AI_CHAT_LIST_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    limit: z.number().int().min(1).max(CHAT_LIST_LIMIT_MAX),
  })
  .strict();

/** §5/§11: ответ list — {messages}; пустая история — валидный ответ (§13). */
export const AI_CHAT_LIST_RESPONSE_SCHEMA = z
  .object({ messages: z.array(CHAT_MESSAGE_DTO_SCHEMA) })
  .strict();

/** Запрос list (§11). */
export type AiChatListRequest = z.infer<typeof AI_CHAT_LIST_REQUEST_SCHEMA>;

/** Ответ list (§11). */
export type AiChatListResponse = z.infer<typeof AI_CHAT_LIST_RESPONSE_SCHEMA>;

/** §5/§11: запрос clear — {} (очистка ВСЕЙ истории; подтверждение — забота UI 090). */
export const AI_CHAT_CLEAR_REQUEST_SCHEMA = z.object({}).strict();

/** §5/§11: ответ clear — {cleared: true} (идемпотентность §13 — всегда успех). */
export const AI_CHAT_CLEAR_RESPONSE_SCHEMA = z.object({ cleared: z.literal(true) }).strict();

/** Запрос clear (§11). */
export type AiChatClearRequest = z.infer<typeof AI_CHAT_CLEAR_REQUEST_SCHEMA>;

/** Ответ clear (§11). */
export type AiChatClearResponse = z.infer<typeof AI_CHAT_CLEAR_RESPONSE_SCHEMA>;
