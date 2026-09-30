/**
 * TASK-081 §5/§7/§11: контракты каналов витрины моделей ai/models/* — экран
 * «Модель» (/ai): список из манифеста одним вызовом (§7: ModelView + машина
 * ramTotalGb + uiLanguage — всё для карточек и предупреждений), запуск загрузки/
 * пауза/докачка/сброс ошибки {modelId} и выбор активной модели {modelId} →
 * prefs.aiSettings.modelId (§9: ensureModel лениво — 087, не на select).
 *
 * Ответы download/pause/resume/reset — форма статуса ModelStatusInfo (080):
 * исход флоу UI читает из ai:progress + ai/models/list, ответ канала — финал
 * (installed/paused) или мгновенный отказ guard'а (AI/DOWNLOAD_BUSY и др.).
 * errorKey — ключ i18n-каталога, не текст (§16–17, прецедент app:log); payload —
 * только сигналы, без PHI (§14).
 */
import { z } from 'zod';

import { MODEL_STATUSES } from './models.js';
import { MODEL_DESCRIPTOR_SCHEMA } from '../models.js';

/**
 * Форма статуса модели ModelStatusInfo (080 §5) в zod — контракт ответов каналов
 * download/pause/resume/reset. Строгая (§14 IPC-гигиены); optionals повторяют
 * интерфейс из models.ts: bytesLoaded (докачка/прогресс), totalBytes, resumable
 * (false — сервер без Range), errorKey (ключ текста терминальной ошибки).
 */
export const AI_MODELS_STATUS_RESPONSE_SCHEMA = z
  .object({
    state: z.enum(MODEL_STATUSES),
    bytesLoaded: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().positive().optional(),
    resumable: z.boolean().optional(),
    errorKey: z.string().min(1).optional(),
  })
  .strict();

/**
 * ModelView (§7) — витрина карточки: дескриптор манифеста (имя/версия/размер/
 * языки/мин. RAM/лицензия — всё видно ДО загрузки, FR-5.8) + статус из 080.
 * bytesLoaded — прогресс/докачка; errorKey — текст терминальной ошибки
 * (state=error). totalBytes/resumable в витрину не входят: total — sizeBytes
 * дескриптора, докачка невозможна UI честно покажет через «Продолжить».
 */
export const MODEL_VIEW_SCHEMA = z
  .object({
    descriptor: MODEL_DESCRIPTOR_SCHEMA,
    state: z.enum(MODEL_STATUSES),
    bytesLoaded: z.number().int().nonnegative().optional(),
    errorKey: z.string().min(1).optional(),
  })
  .strict();

/** ModelView — карточка экрана «Модель» (§7). */
export type ModelView = z.infer<typeof MODEL_VIEW_SCHEMA>;

/** Запрос list (§11): {} — параметров нет. */
export const AI_MODELS_LIST_REQUEST_SCHEMA = z.object({}).strict();

/** Запрос list (§11). */
export type AiModelsListRequest = z.infer<typeof AI_MODELS_LIST_REQUEST_SCHEMA>;

/**
 * Ответ list (§7/§11): одним вызовом всё для экрана — витрины, ОЗУ машины
 * (os.totalmem main, дробные ГБ — честное сравнение с minRamGb) и язык
 * интерфейса (для предупреждения FR-5.9 о несовпадении с языком модели).
 */
export const AI_MODELS_LIST_RESPONSE_SCHEMA = z
  .object({
    models: z.array(MODEL_VIEW_SCHEMA),
    ramTotalGb: z.number().positive(),
    uiLanguage: z.string().min(1),
  })
  .strict();

/** Ответ list (§7). */
export type AiModelsListResponse = z.infer<typeof AI_MODELS_LIST_RESPONSE_SCHEMA>;

/**
 * Общий запрос каналов действия {modelId} (§5/§11): download/pause/resume/reset/
 * select — одинаковая форма (прецедент общих схем report/export-*).
 */
export const AI_MODELS_MODEL_ID_REQUEST_SCHEMA = z.object({ modelId: z.string().min(1) }).strict();

/** Общий запрос каналов действия (§11). */
export type AiModelsModelIdRequest = z.infer<typeof AI_MODELS_MODEL_ID_REQUEST_SCHEMA>;

/** Запрос download (§5/§11) — алиас общей формы (разные каналы, одна форма). */
export const AI_MODELS_DOWNLOAD_REQUEST_SCHEMA = AI_MODELS_MODEL_ID_REQUEST_SCHEMA;

/** Ответ select (§5/§9/§11): эхо выбранного id (prefs пишет use case main). */
export const AI_MODELS_SELECT_RESPONSE_SCHEMA = z.object({ modelId: z.string().min(1) }).strict();

/** Ответ select. */
export type AiModelsSelectResponse = z.infer<typeof AI_MODELS_SELECT_RESPONSE_SCHEMA>;

/** Ответ reset — та же форма статуса (reset → not_installed, §7 080). */
export const AI_MODELS_RESET_RESPONSE_SCHEMA = AI_MODELS_STATUS_RESPONSE_SCHEMA;

/** Ответ pause — статус после паузы (paused + bytesLoaded, §5 080). */
export const AI_MODELS_PAUSE_RESPONSE_SCHEMA = AI_MODELS_STATUS_RESPONSE_SCHEMA;

/** Ответ resume — финал докачки (installed/paused/error-отказ, §5 080). */
export const AI_MODELS_RESUME_RESPONSE_SCHEMA = AI_MODELS_STATUS_RESPONSE_SCHEMA;
