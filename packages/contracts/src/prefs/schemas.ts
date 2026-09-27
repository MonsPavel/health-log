/**
 * TASK-047 §5/§11: zod-схемы каналов `prefs/get|set` и единого документа настроек
 * Prefs (арх. 05 §3, модуль settings-profile). Документ — НЕ по-ключево: атомарные
 * чтения всего набора (§5), дефолты значений — DEFAULT_PREFS в PreferencesService
 * (main, §8), схема здесь — контракт формы.
 *
 * СЕМАНТИКА PATCH (§7/§9): PREFS_PATCH_SCHEMA — режим strip (не strict): неизвестные
 * ключи отбрасываются zod-валидацией (AC5 «строгий merge: неизвестное — отброшено,
 * валидные применены»), неверный ТИП значения — ошибка (VALIDATION/FAILED, §11).
 * Вложенные netConsents — объектом ЦЕЛИКОМ (без deep-merge: пока одно поле-согласие,
 §5; granular — будущая работа §5).
 *
 * Все объекты ответов и обёртка запроса .strict() (§14: IPC-гигиена TASK-008).
 */
import { z } from 'zod';

/** §5: режим темы — system следит за ОС, light/dark — явный выбор. */
export const THEME_SCHEMA = z.enum(['system', 'light', 'dark']);

/** §5: масштаб текста — строки-классы rem ('112.5' → hl-text-112, TASK-013). */
export const TEXT_SCALE_SCHEMA = z.enum(['100', '112.5', '125']);

/** §5/§13: формат даты — auto = Intl по локали, dmy/mdy — явный выбор. */
export const DATE_FORMAT_SCHEMA = z.enum(['auto', 'dmy', 'mdy']);

/**
 * §5/§14: сетевые согласия. Поле схемы уже здесь; UI-редактор — TASK-099, читает
 * только EgressGateway (TASK-075). Объектом целиком — без deep-merge (см. шапку).
 */
export const NET_CONSENTS_SCHEMA = z.object({ updatesCheck: z.boolean() }).strict();

/** §5: единый документ настроек (атомарное чтение/запись). */
export const PREFS_SCHEMA = z
  .object({
    theme: THEME_SCHEMA,
    textScale: TEXT_SCALE_SCHEMA,
    dateFormat: DATE_FORMAT_SCHEMA,
    /** §5: крупный режим (TASK-048) — поле схемы уже, UI — своя задача. */
    advancedMode: z.boolean(),
    netConsents: NET_CONSENTS_SCHEMA,
  })
  .strict();

/**
 * §5/§9: patch канала prefs/set — strip-режим: неизвестные ключи zod отбрасывает
 * (AC5), типы проверяет; все поля опциональны (merge в сервисе, §9).
 */
export const PREFS_PATCH_SCHEMA = z.object({
  theme: THEME_SCHEMA.optional(),
  textScale: TEXT_SCALE_SCHEMA.optional(),
  dateFormat: DATE_FORMAT_SCHEMA.optional(),
  advancedMode: z.boolean().optional(),
  netConsents: NET_CONSENTS_SCHEMA.optional(),
});

/** §11: запрос prefs/get — полный документ без параметров. */
export const PREFS_GET_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ prefs/get — полный документ. */
export const PREFS_GET_RESPONSE_SCHEMA = PREFS_SCHEMA;

/** §11: запрос prefs/set — {patch}. */
export const PREFS_SET_REQUEST_SCHEMA = z.object({ patch: PREFS_PATCH_SCHEMA }).strict();

/** §11: ответ prefs/set — обновлённый ПОЛНЫЙ документ (§11). */
export const PREFS_SET_RESPONSE_SCHEMA = PREFS_SCHEMA;
