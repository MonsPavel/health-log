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
 * TASK-075 §5: + modelsDownload (загрузка моделей, согласие запрашивается в
 * TASK-081 UI) — с дефолтом false: усечённый/старый документ (§22, восстановление
 * из копии до расширения схемы) парсится с заполнением недостающего БЕЗ сброса
 * уже выданных согласий (updatesCheck читается как сохранён).
 */
export const NET_CONSENTS_SCHEMA = z
  .object({ updatesCheck: z.boolean(), modelsDownload: z.boolean().default(false) })
  .strict();

/** TASK-074 §5: метаданные последней копии — путь/дата (пишет onSuccess канала backup/create). */
export const JOB_LAST_BACKUP_SCHEMA = z.object({ path: z.string(), at: z.number() }).strict();

/**
 * TASK-081 §5: настройки ИИ — выбор активной модели (prefs.aiSettings.modelId;
 * ensureModel лениво при генерации — 087, не на select, §9) и решение «настроить
 * позже» (dismissed — баннер «ИИ не настроен» скрыт НАВСЕГДА до явного «Настроить»
 * из настроек; РЕШЕНИЕ спеки — просто). Объект заменяется ЦЕЛИКОМ (семантика
 * netConsents/jobState — без deep-merge); писатель (use case select / UI) читает
 * документ и возвращает обновлённый целиком.
 */
export const AI_SETTINGS_SCHEMA = z
  .object({
    /** Выбранная модель (id из манифеста); absent — не выбрана. */
    modelId: z.string().min(1).optional(),
    /** «Настроить позже»: баннер не возвращается до явной настройки (§5 РЕШЕНИЕ). */
    dismissed: z.boolean().default(false),
    /**
     * TASK-088 §5: «включить заметки» (FR-5.5) — тумблер экрана «Разбор»,
     * персистентен (выбор переживает перезапуск); дефолт false — заметки в
     * контекст ИИ ТОЛЬКО по явной опции (§14 083). Участник hash кэша (083).
     */
    includeNotes: z.boolean().default(false),
  })
  .strict();

/**
 * TASK-074 §5/§12: состояние каркасных задач (JobScheduler) — персистентно в prefs:
 * lastRun задач (jobs: имя → utcMs), дедупликация показа подсказок (shown:
 * kind → utcMs, «не чаще раза в неделю» §13) и метаданные последней копии.
 * Объект заменяется ЦЕЛИКОМ (семантика netConsents — без deep-merge): писатель
 * (scheduler/main) читает документ и возвращает обновлённый целиком.
 */
export const JOB_STATE_SCHEMA = z
  .object({
    lastBackup: JOB_LAST_BACKUP_SCHEMA.optional(),
    jobs: z.record(z.string(), z.number()).default({}),
    shown: z.record(z.string(), z.number()).default({}),
  })
  .strict();

/**
 * §5/§22: единый документ настроек (атомарное чтение/запись). Zod-дефолты в схеме —
 * ЕДИНСТВЕННЫЙ источник значений по умолчанию (§8: DEFAULT_PREFS сервиса = parse({})):
 * усечённый/старый документ (восстановление из копии до расширения схемы, §22)
 * парсится с заполнением недостающего — безопасно, без сброса к чистым дефолтам.
 */
export const PREFS_SCHEMA = z
  .object({
    theme: THEME_SCHEMA.default('system'),
    textScale: TEXT_SCALE_SCHEMA.default('100'),
    dateFormat: DATE_FORMAT_SCHEMA.default('auto'),
    /** §5: крупный режим (TASK-048) — поле схемы уже, UI — своя задача. */
    advancedMode: z.boolean().default(false),
    /** §14: согласие на сеть по умолчанию НЕ дано (приватность first). */
    netConsents: NET_CONSENTS_SCHEMA.default({ updatesCheck: false, modelsDownload: false }),
    /** TASK-074 §5: состояние задач планировщика (последний запуск, показы, копия). */
    jobState: JOB_STATE_SCHEMA.default({ jobs: {}, shown: {} }),
    /** TASK-081 §5: настройки ИИ — выбранная модель + «настроить позже». */
    aiSettings: AI_SETTINGS_SCHEMA.default({ dismissed: false, includeNotes: false }),
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
  // TASK-074 §5/§12: jobState пишут use case'ы/планировщик main (объектом целиком).
  jobState: JOB_STATE_SCHEMA.optional(),
  // TASK-081 §5: aiSettings пишет use case select и UI «настроить позже» (целиком).
  aiSettings: AI_SETTINGS_SCHEMA.optional(),
});

/** §11: запрос prefs/get — полный документ без параметров. */
export const PREFS_GET_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ prefs/get — полный документ. */
export const PREFS_GET_RESPONSE_SCHEMA = PREFS_SCHEMA;

/** §11: запрос prefs/set — {patch}. */
export const PREFS_SET_REQUEST_SCHEMA = z.object({ patch: PREFS_PATCH_SCHEMA }).strict();

/** §11: ответ prefs/set — обновлённый ПОЛНЫЙ документ (§11). */
export const PREFS_SET_RESPONSE_SCHEMA = PREFS_SCHEMA;
