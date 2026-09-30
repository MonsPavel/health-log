/**
 * TASK-083 §5/§11: контракты канала `ai/context/preview` — превью ИИ-контекста
 * (детерминированная проекция периода, арх. 07 §3) — нужен UI раньше резюме
 * (§11 РЕШЕНИЕ: канал включён в объём TASK-083). Запрос {profileId, period,
 * includeNotes} — период переиспользует схему TASK-054 (§23 054: копии периода
 * не создавать); includeNotes управляет секцией заметок (FR-5.5, §14: заметки —
 * ТОЛЬКО по явной опции). modelId в запрос НЕ входит: main берёт активную модель
 * из prefs.aiSettings.modelId (§5: modelId — вход сборщика, резолвит канал).
 *
 * Ответ {text, sections, hash}: text — точный текст проекции (превью FR-5.5 —
 * моноширинный блок 088), sections — EN-идентификаторы присутствующих секций
 * (§17: маркеры EN для LLM-стабильности, подписи RU в тексте; UI-переключатель
 * заметок 088 работает по наличию 'notes'), hash — SHA-256 canonical-строки
 * (hex, §2: кэш резюме FR-5.7 и воспроизводимость eval 091 стоят на нём).
 *
 * text — PHI (заметки пользователя): наружу уходит ТОЛЬКО в превью канала,
 * в лог не пишется (§14). Все объекты .strict() (§14); типы выводятся из схем
 * (z.infer, §23). Секционный список — общий контракт сборщика и UI (§10).
 */
import { z } from 'zod';

import { STATS_PERIOD_PARAM_SCHEMA } from '../stats/schemas.js';

/** §14: профиль-владелец — та же гигиена длины, что у measurement/stats (≤64). */
const PROFILE_ID_MAX_LENGTH = 64;

/**
 * EN-идентификаторы секций текста (§4/§17): фиксированный порядок отображения —
 * period, aggregates, daily, gaps, notes, scale. Единственный источник для
 * сборщика (секция в тексте ⇔ id в ответе) и UI 088 (§10: превью по секциям).
 */
export const AI_CONTEXT_SECTION_IDS = [
  'period',
  'aggregates',
  'daily',
  'gaps',
  'notes',
  'scale',
] as const;

/** Идентификатор секции (§5/§17). */
export type AiContextSectionId = (typeof AI_CONTEXT_SECTION_IDS)[number];

/** Секция ИИ-контекста на проводе (§11): та же гигиена, что у остальных enum. */
export const AI_CONTEXT_SECTION_SCHEMA = z.enum(AI_CONTEXT_SECTION_IDS);

/** §5/§11: запрос preview — {profileId, period, includeNotes} (modelId резолвит main). */
export const AI_CONTEXT_PREVIEW_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    period: STATS_PERIOD_PARAM_SCHEMA,
    includeNotes: z.boolean(),
  })
  .strict();

/**
 * §11: ответ preview — {text, sections, hash}. hash — hex SHA-256 (64 знака);
 * sections — присутствующие секции в фиксированном порядке AI_CONTEXT_SECTION_IDS
 * ('notes' отсутствует при includeNotes=false — §13/§14).
 */
export const AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA = z
  .object({
    text: z.string(),
    sections: z.array(AI_CONTEXT_SECTION_SCHEMA),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Запрос preview (§11). */
export type AiContextPreviewRequest = z.infer<typeof AI_CONTEXT_PREVIEW_REQUEST_SCHEMA>;

/** Ответ preview (§11). */
export type AiContextPreviewResponse = z.infer<typeof AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA>;
