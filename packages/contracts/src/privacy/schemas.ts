/**
 * TASK-098 §5/§11: контракты каналов экрана «Приватность» (US-33, витрина BG-2).
 * `privacy/journal {limit=50} → {entries, ops}` — последние записи журнала сети
 * (network_event v5, TASK-075) + перечень ВСЕХ возможных операций с их назначением
 * (список генерируется main'ом из EgressPolicy.ALLOWED — не дублируется руками, §4:
 * новая сетевая операция появляется в UI автоматически). `privacy/consents
 * {patch?} → Consents` — чтение (без patch) / переключение (patch) согласий;
 * согласия меняются ТОЛЬКО этим каналом (§14, prefs direct-запись из UI запрещена).
 *
 * Все схемы strict (§14 IPC-гигиены); patch согласий — строго по известным ключам
 * (неизвестный ключ → отказ VALIDATION каркаса, §5/§14). Форма Consents — тот же
 * документ prefs.netConsents (§23: переиспользование схемы, единый источник);
 * ошибки каналов — только валидационные (§11).
 */
import { z } from 'zod';

import { NET_CONSENTS_SCHEMA } from '../prefs/schemas.js';

/**
 * Статус записи журнала — домен EgressGateway (TASK-075 §5): жизненный цикл
 * running → ok|failed; blocked — отказ политики/согласия ДО сети (журнал честен
 * и про отказы, §9 TASK-075). Зеркалим строкой (contracts не знает main).
 */
export const NETWORK_EVENT_STATUS_SCHEMA = z.enum(['running', 'ok', 'failed', 'blocked']);

/**
 * §5: запись журнала сети — ТОЛЬКО метаданные (kind/endpoint/status/bytes/atUtc;
 * §7 TASK-075: URL не содержит PHI — CDN моделей/сервер обновлений, тела запросов
 * не журналируются никогда). bytes — опционален: NULL журнала (blocked/failed/ответ
 * без content-length) отображается отсутствием поля (§5 «bytes?»).
 */
export const NETWORK_EVENT_DTO_SCHEMA = z
  .object({
    kind: z.string().min(1),
    endpoint: z.string(),
    status: NETWORK_EVENT_STATUS_SCHEMA,
    bytes: z.number().int().min(0).optional(),
    atUtc: z.number().int().min(0),
  })
  .strict();

/**
 * §4/§5: строка перечня операций — генерируется main'ом из строки политики
 * ALLOWED: op — имя операции, consentKey — ключ согласия prefs.netConsents,
 * descriptionKey — i18n-ключ описания «зачем» (тексты — каталог UI TASK-099,
 * без текстов в main, §9), enabled — текущее состояние согласия (UI рисует
 * переключатель из этого поля).
 */
export const PRIVACY_OPERATION_SCHEMA = z
  .object({
    op: z.string().min(1),
    consentKey: z.string().min(1),
    descriptionKey: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

/** §5/§11: запрос privacy/journal — {limit=50} (последние N записей, §15 «мгновенно»). */
export const PRIVACY_JOURNAL_REQUEST_SCHEMA = z
  .object({ limit: z.number().int().min(1).default(50) })
  .strict();

/** §5/§11: ответ privacy/journal — записи (desc по at_utc, сортирует main) + перечень операций. */
export const PRIVACY_JOURNAL_RESPONSE_SCHEMA = z
  .object({
    entries: z.array(NETWORK_EVENT_DTO_SCHEMA),
    ops: z.array(PRIVACY_OPERATION_SCHEMA),
  })
  .strict();

/**
 * §5/§14: patch согласий — строго известные ключи (ключи — из политики: инвариант
 * «ops генерируются из ALLOWED» main-тестов защищает соответствие). Неизвестный
 * ключ → отказ zod → VALIDATION каркаса (§11).
 */
export const PRIVACY_CONSENTS_PATCH_SCHEMA = z
  .object({
    updatesCheck: z.boolean().optional(),
    modelsDownload: z.boolean().optional(),
  })
  .strict();

/** §11: запрос privacy/consents — {} (чтение) или {patch} (переключение, §2). */
export const PRIVACY_CONSENTS_REQUEST_SCHEMA = z
  .object({ patch: PRIVACY_CONSENTS_PATCH_SCHEMA.optional() })
  .strict();

/**
 * §5/§23: ответ — согласия в форме документа prefs.netConsents (та же схема —
 * единый источник формы: экран читает и переключает ровно то, чем управляет
 * gateway, §14).
 */
export const PRIVACY_CONSENTS_RESPONSE_SCHEMA = NET_CONSENTS_SCHEMA;

/** Запрос privacy/journal. */
export type PrivacyJournalRequest = z.infer<typeof PRIVACY_JOURNAL_REQUEST_SCHEMA>;

/** Статус записи журнала (зеркало домена TASK-075). */
export type NetworkEventStatusDto = z.infer<typeof NETWORK_EVENT_STATUS_SCHEMA>;

/** Запись журнала сети (§5). */
export type NetworkEventDto = z.infer<typeof NETWORK_EVENT_DTO_SCHEMA>;

/** Строка перечня операций (§4/§5). */
export type OperationInfo = z.infer<typeof PRIVACY_OPERATION_SCHEMA>;

/** Ответ privacy/journal (§2). */
export type PrivacyJournalResponse = z.infer<typeof PRIVACY_JOURNAL_RESPONSE_SCHEMA>;

/** Patch согласий (§5/§14). */
export type PrivacyConsentsPatch = z.infer<typeof PRIVACY_CONSENTS_PATCH_SCHEMA>;

/** Запрос privacy/consents (§11). */
export type PrivacyConsentsRequest = z.infer<typeof PRIVACY_CONSENTS_REQUEST_SCHEMA>;

/** Согласия (форма prefs.netConsents, §5/§23). */
export type Consents = z.infer<typeof PRIVACY_CONSENTS_RESPONSE_SCHEMA>;

/** Ответ privacy/consents (§11). */
export type PrivacyConsentsResponse = z.infer<typeof PRIVACY_CONSENTS_RESPONSE_SCHEMA>;
