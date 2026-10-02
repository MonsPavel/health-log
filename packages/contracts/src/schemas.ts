/**
 * TASK-008 §5: реестр zod-схем прикладных каналов — единственное место знания о
 * формах payload (арх. 05 §1). Схемы strict по умолчанию (§14: prototype-pollution);
 * типы выводятся из схем (z.infer) — никакой ручной синхронизации (§23).
 */
import { z } from 'zod';

import { BENCH_SEED_REQUEST_SCHEMA, BENCH_SEED_RESPONSE_SCHEMA } from './bench.js';
import type { ChannelName } from './channels.js';
// TASK-100 §5/§11: сампроверка старта и версии «О приложении» (схемы — app-info.ts).
import {
  APP_INTEGRITY_FULL_REQUEST_SCHEMA,
  APP_INTEGRITY_FULL_RESPONSE_SCHEMA,
  APP_META_REQUEST_SCHEMA,
  APP_META_RESPONSE_SCHEMA,
  APP_SELFCHECK_REQUEST_SCHEMA,
  APP_SELFCHECK_RESPONSE_SCHEMA,
} from './app-info.js';
import {
  AI_MODELS_LIST_REQUEST_SCHEMA,
  AI_MODELS_LIST_RESPONSE_SCHEMA,
  AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
  AI_MODELS_RESET_RESPONSE_SCHEMA,
  AI_MODELS_SELECT_RESPONSE_SCHEMA,
  AI_MODELS_STATUS_RESPONSE_SCHEMA,
} from './ai/models-channels.js';
import {
  AI_CONTEXT_PREVIEW_REQUEST_SCHEMA,
  AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA,
} from './ai/context-channels.js';
import {
  AI_CANCEL_REQUEST_SCHEMA,
  AI_CANCEL_RESPONSE_SCHEMA,
  AI_SUMMARY_DELETE_ALL_REQUEST_SCHEMA,
  AI_SUMMARY_DELETE_ALL_RESPONSE_SCHEMA,
  AI_SUMMARY_GENERATE_REQUEST_SCHEMA,
  AI_SUMMARY_GENERATE_RESPONSE_SCHEMA,
  AI_SUMMARY_LATEST_REQUEST_SCHEMA,
  AI_SUMMARY_LATEST_RESPONSE_SCHEMA,
} from './ai/summary-channels.js';
import {
  AI_CHAT_CLEAR_REQUEST_SCHEMA,
  AI_CHAT_CLEAR_RESPONSE_SCHEMA,
  AI_CHAT_LIST_REQUEST_SCHEMA,
  AI_CHAT_LIST_RESPONSE_SCHEMA,
  AI_CHAT_SEND_REQUEST_SCHEMA,
  AI_CHAT_SEND_RESPONSE_SCHEMA,
} from './ai/chat-channels.js';
import {
  BACKUP_CREATE_REQUEST_SCHEMA,
  BACKUP_CREATE_RESPONSE_SCHEMA,
  BACKUP_RESTORE_REQUEST_SCHEMA,
  BACKUP_RESTORE_RESPONSE_SCHEMA,
  DATA_WIPE_REQUEST_SCHEMA,
  DATA_WIPE_RESPONSE_SCHEMA,
} from './data-care/schemas.js';
import { FILE_OPEN_DIALOG_REQUEST_SCHEMA, FILE_OPEN_DIALOG_RESPONSE_SCHEMA } from './file.js';
// TASK-095 §5/§11: канал heartbeat активности (сигнал автоблока; НЕ secure).
import { HEARTBEAT_REQUEST_SCHEMA, HEARTBEAT_RESPONSE_SCHEMA } from './heartbeat.js';
import {
  MEASUREMENT_ADD_REQUEST_SCHEMA,
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  MEASUREMENT_DELETE_REQUEST_SCHEMA,
  MEASUREMENT_DELETE_RESPONSE_SCHEMA,
  MEASUREMENT_LIST_REQUEST_SCHEMA,
  MEASUREMENT_LIST_RESPONSE_SCHEMA,
  MEASUREMENT_UPDATE_REQUEST_SCHEMA,
  MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
} from './measurement/schemas.js';
import { NOTES_SEARCH_REQUEST_SCHEMA, NOTES_SEARCH_RESPONSE_SCHEMA } from './notes/schemas.js';
import {
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_GET_RESPONSE_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
  PREFS_SET_RESPONSE_SCHEMA,
} from './prefs/schemas.js';
// TASK-098 §5/§11: каналы экрана «Приватность» (журнал сети + перечень операций
// из политики; чтение/переключение согласий — единственный канал их изменения).
import {
  PRIVACY_CONSENTS_REQUEST_SCHEMA,
  PRIVACY_CONSENTS_RESPONSE_SCHEMA,
  PRIVACY_JOURNAL_REQUEST_SCHEMA,
  PRIVACY_JOURNAL_RESPONSE_SCHEMA,
} from './privacy/schemas.js';
import {
  REPORT_EXPORT_REQUEST_SCHEMA,
  REPORT_EXPORT_RESPONSE_SCHEMA,
  REPORT_PDF_REQUEST_SCHEMA,
  REPORT_PDF_RESPONSE_SCHEMA,
  REVEAL_PATH_REQUEST_SCHEMA,
} from './report/schemas.js';
import { SCALES_ACTIVE_REQUEST_SCHEMA, SCALES_ACTIVE_RESPONSE_SCHEMA } from './scales.js';
import { STATS_REQUEST_SCHEMA, STATS_RESPONSE_SCHEMA } from './stats/schemas.js';
import { TREND_REQUEST_SCHEMA, TREND_RESPONSE_SCHEMA } from './trends.js';
// TASK-096 §5/§11: каналы обновлений приложения (ручной режим electron-updater
// за согласием prefs.netConsents.updatesCheck — NFR-11).
import {
  UPDATES_CHECK_REQUEST_SCHEMA,
  UPDATES_DOWNLOAD_REQUEST_SCHEMA,
  UPDATES_INSTALL_REQUEST_SCHEMA,
  UPDATES_INSTALL_RESPONSE_SCHEMA,
  UPDATES_STATUS_RESPONSE_SCHEMA,
} from './updates.js';
// TASK-094 §5/§11: каналы локального входа (VaultService main; НЕ secure —
// доступны при locked, иначе вход невозможен).
import {
  VAULT_LOCK_REQUEST_SCHEMA,
  VAULT_LOCK_RESPONSE_SCHEMA,
  VAULT_SET_PASSPHRASE_REQUEST_SCHEMA,
  VAULT_SET_PASSPHRASE_RESPONSE_SCHEMA,
  VAULT_STATUS_REQUEST_SCHEMA,
  VAULT_STATUS_RESPONSE_SCHEMA,
  VAULT_UNLOCK_REQUEST_SCHEMA,
  VAULT_UNLOCK_RESPONSE_SCHEMA,
} from './vault.js';

/**
 * Пара схем канала: запрос валидируется в main до handler, ответ — контракт хендлера.
 *
 * TASK-094 §7/§11: secure: true помечает БД-канал — каркас main (register-channel,
 * ЕДИНАЯ обёртка requireUnlocked) отклоняет вызов в locked-состоянии конвертом
 * VAULT/LOCKED ДО вызова хендлера (инвариант §7: при locked repository-операции
 * недоступны; инвентарь-тест vault.test.ts ловит канал без решения о secure — AC5).
 */
export interface ChannelSchemas<TRequest = unknown, TResponse = unknown> {
  readonly request: z.ZodType<TRequest>;
  readonly response: z.ZodType<TResponse>;
  /** БД-канал: при locked вызов отклоняется гвардией каркаса (VAULT/LOCKED, §7/§11). */
  readonly secure?: boolean;
}

/**
 * Реестр каналов: `Record<ChannelName, ChannelSchemas>` (§5). Новый канал = запись
 * здесь + строка в union ChannelName; компилятор не даст забыть ни одну из сторон.
 */
export const CHANNEL_SCHEMAS = {
  /**
   * TASK-062 §9/§11: TEST-ONLY сидинг синтетики bench — {count} → {inserted}
   * (одна транзакция на main). Регистрируется только при env HL_BENCH=1 и не в
   * packaged (двойной гард main §14); без флага — «неизвестный канал» каркаса.
   */
  '__bench/seed': {
    request: BENCH_SEED_REQUEST_SCHEMA,
    response: BENCH_SEED_RESPONSE_SCHEMA,
    // TASK-094 §11: канал пишет в БД (сидинг) — secure (TEST-ONLY регистрация).
    secure: true,
  },
  /**
   * TASK-081 §5/§7/§11: витрина моделей (экран «Модель», /ai). list — одним
   * вызовом всё для экрана (§7: витрины + ОЗУ машины + язык UI); download/
   * resume — финал флоу загрузки (долгий ответ: ход — событиями ai:progress,
   * §11), pause/reset — статус сразу; select — prefs.aiSettings.modelId
   * (ensureModel лениво при генерации — 087, §9; быстрый UI).
   */
  'ai/models/list': {
    request: AI_MODELS_LIST_REQUEST_SCHEMA,
    response: AI_MODELS_LIST_RESPONSE_SCHEMA,
    // TASK-094 §11: ai-каналы — secure (§11 «все … ai … каналы»).
    secure: true,
  },
  'ai/models/download': {
    request: AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
    response: AI_MODELS_STATUS_RESPONSE_SCHEMA,
    // TASK-094 §11: журнал сети gateway пишет в network_event (БД) — secure.
    secure: true,
  },
  'ai/models/pause': {
    request: AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
    response: AI_MODELS_STATUS_RESPONSE_SCHEMA,
    secure: true,
  },
  'ai/models/resume': {
    request: AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
    response: AI_MODELS_STATUS_RESPONSE_SCHEMA,
    secure: true,
  },
  'ai/models/reset': {
    request: AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
    response: AI_MODELS_RESET_RESPONSE_SCHEMA,
    secure: true,
  },
  'ai/models/select': {
    request: AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
    response: AI_MODELS_SELECT_RESPONSE_SCHEMA,
    // select пишет prefs (app_setting, БД) — secure (§7).
    secure: true,
  },
  /**
   * TASK-083 §5/§11: превью ИИ-контекста — {profileId, period, includeNotes} →
   * {text, sections, hash}. modelId в запрос не входит — main резолвит активную
   * модель из prefs (§5); text — PHI: в лог не пишется (§14). Период — та же
   * схема, что stats/trend (§23 054: переиспользование обязательно).
   */
  'ai/context/preview': {
    request: AI_CONTEXT_PREVIEW_REQUEST_SCHEMA,
    response: AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-087 §5/§11: генерация резюме (UC-03) — {profileId, period, includeNotes} →
   * {requestId} (стрим: данные — событиями ai:token/ai:status, финал — событие
   * 'ai/summary/result', арх. 05 §3 «стриминг»; modelId резолвит main из prefs).
   * contentMd — PHI: в лог не пишется, наружу только владельцу (§14).
   */
  'ai/summary/generate': {
    request: AI_SUMMARY_GENERATE_REQUEST_SCHEMA,
    response: AI_SUMMARY_GENERATE_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-087 §12: мини-канал стейлс-бейджа — {profileId, period} → {summary, stale}|
   * undefined (готовый флаг data_version записи против текущего — §7; undefined —
   * резюме с такими границами нет, валидный ответ).
   */
  'ai/summary/latest': {
    request: AI_SUMMARY_LATEST_REQUEST_SCHEMA,
    response: AI_SUMMARY_LATEST_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-088 §5: «Очистить разборы» — {} → null (вызов порта deleteAll 087:
   * необратимая очистка КЭША резюме, дневник не трогается; подтверждение —
   * диалог UI перед вызовом). Ответ null — fire-and-forget (прецедент
   * app/reveal-path).
   */
  'ai/summary/delete-all': {
    request: AI_SUMMARY_DELETE_ALL_REQUEST_SCHEMA,
    response: AI_SUMMARY_DELETE_ALL_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-089 §5/§11: чат поверх данных (US-19) — send {profileId, question,
   * period} → {requestId} (стрим: данные — событиями ai:token, финал — событие
   * 'ai/chat/result', арх. 05 §3 «стриминг»; modelId резолвит main из prefs);
   * list {profileId, limit} → {messages} — инициализация UI (§12); clear {} →
   * {cleared: true} — необратимая очистка истории (§13: идемпотентна).
   * content сообщений — PHI: в лог не пишется, наружу только владельцу (§14).
   */
  'ai/chat/send': {
    request: AI_CHAT_SEND_REQUEST_SCHEMA,
    response: AI_CHAT_SEND_RESPONSE_SCHEMA,
    secure: true,
  },
  'ai/chat/clear': {
    request: AI_CHAT_CLEAR_REQUEST_SCHEMA,
    response: AI_CHAT_CLEAR_RESPONSE_SCHEMA,
    secure: true,
  },
  'ai/chat/list': {
    request: AI_CHAT_LIST_REQUEST_SCHEMA,
    response: AI_CHAT_LIST_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-087 §5 п.5: отмена генерации по requestId (арх. 05 §3, EC-16) — abort
   * сигнала активного запроса; незнакомый/повторный — {cancelled: false} без ошибки.
   * Частичный ответ не сохраняется (решение §5), финал уходит событием.
   */
  'ai/cancel': {
    request: AI_CANCEL_REQUEST_SCHEMA,
    response: AI_CANCEL_RESPONSE_SCHEMA,
    // TASK-094 §11: ai-домен целиком secure (при locked отменять нечего).
    secure: true,
  },
  'app/ping': {
    request: z.object({}).strict(),
    response: z.object({ pong: z.literal(true), ts: z.number() }).strict(),
  },
  /**
   * TASK-011 §7/§11: клиентский отчёт об ошибке из ErrorBoundary. Стек и текст
   * исключения наружу не уходят (§14) — только messageKey каталога и digest
   * (хеш message+первой строки стека, ≤64) для дедупликации в логах (§18).
   * Ответ null: канал fire-and-forget (§9).
   */
  'app/log-client-error': {
    request: z
      .object({
        code: z.literal('APP/RENDERER'),
        messageKey: z.string().max(200),
        digest: z.string().max(64),
      })
      .strict(),
    response: z.null(),
  },
  /**
   * TASK-068 §5/§11: «открыть папку» после сохранения отчёта/экспорта —
   * {path} → null (fire-and-forget, §9). Путь — тот, что вернул наш же save-диалог
   * (UX-удобство на своей машине, решение §11 — без санитизации).
   */
  'app/reveal-path': {
    request: REVEAL_PATH_REQUEST_SCHEMA,
    response: z.null(),
  },
  /**
   * TASK-095 §5/§9/§11: heartbeat пользовательской активности рендерера (эпик 6.1) —
   * {} → null (fire-and-forget, прецедент app/reveal-path). Хендлер продлевает окно
   * автоблока (VaultService.touchActivity); НЕ secure — активность продлевает сессию
   * и в locked (минимальный входной набор, прецедент vault/status).
   */
  'app/heartbeat': {
    request: HEARTBEAT_REQUEST_SCHEMA,
    response: HEARTBEAT_RESPONSE_SCHEMA,
  },
  /**
   * TASK-100 §5/§11: сампроверка старта — {} → SelfCheckReport | null (иммутабельный
   * снимок §7: полная проверка — отдельный канал, стартовый отчёт не мутируется).
   * НЕ secure: отчёт хранится в памяти main (заполнен после открытия БД; до unlock —
   * null), PHI/путей не содержит (§14 — безопасен для диагпакета 103).
   */
  'app/selfcheck': {
    request: APP_SELFCHECK_REQUEST_SCHEMA,
    response: APP_SELFCHECK_RESPONSE_SCHEMA,
  },
  /**
   * TASK-100 §5/§11: версии «О приложении» — {} → {appVersion, schemaVersion, scale,
   * model?} (модель опциональна — не выбрана). НЕ secure: канал версий/режима —
   * в recovery-режиме TASK-101 §9 остаётся доступным; данные без PHI (§14).
   */
  'app/meta': {
    request: APP_META_REQUEST_SCHEMA,
    response: APP_META_RESPONSE_SCHEMA,
  },
  /**
   * TASK-100 §4/§11: полная проверка БД по кнопке — {} → {ok, details} (вывод
   * PRAGMA integrity_check; progress не нужен: <10 с, §11). secure: БД-канал —
   * при locked соединение закрыто (гвардия даёт честный VAULT/LOCKED).
   */
  'app/integrity-full': {
    request: APP_INTEGRITY_FULL_REQUEST_SCHEMA,
    response: APP_INTEGRITY_FULL_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-070 §6/§11: создание копии (Data Care) — {mode:'ask', passphrase} |
   * {mode:'auto', targetName?} → {file: basename, sizeBytes, manifest}.
   * Канал-контракт и формат манифеста — здесь; регистрация хендлера и диалоги —
   * TASK-073 (§6 РЕШЕНИЕ). Пароль копии ≠ пароль приложения (§14).
   */
  'backup/create': {
    request: BACKUP_CREATE_REQUEST_SCHEMA,
    response: BACKUP_CREATE_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-071 §6/§11: восстановление из копии (Data Care) — двухфазный канал:
   * фаза 1 {file, passphrase, confirmed: false} → {plan} (предупреждения — UI
   * показывает до подтверждения); фаза 2 {…, confirmed: true} → {restarting: true}
   * (замена БД + отложенный relaunch, §9). Регистрация хендлера — TASK-073.
   */
  'backup/restore': {
    request: BACKUP_RESTORE_REQUEST_SCHEMA,
    response: BACKUP_RESTORE_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-072 §5/§11: полное удаление данных (Data Care) — двухфазный канал по
   * `phase`: {phase:'plan'} → {plan: WipePlan} (basename+категория — пути от
   * renderer не принимаются и наружу не идут, §7/§14); {phase:'execute'} →
   * {restarting: true} (unlink по плану + отложенный relaunch, §9). Ошибки —
   * WIPE/FAILED (частичный сбой: remainingCount в params). Регистрация хендлера
   * и команда renderer'у на очистку localStorage — TASK-073.
   */
  'data/wipe': {
    request: DATA_WIPE_REQUEST_SCHEMA,
    response: DATA_WIPE_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-073 §6/§9/§11: выбор файла копии для восстановления — {filters} →
   * {path} | {canceled: true} (отмена — не ошибка, §7). Путь файла выбирает
   * open-диалог ОС в main (§14: renderer путь не присылает — паритет save-диалога
   * экспорта 065); форма ответа — переиспользование union экспорта (§23).
   */
  'file/open-dialog': {
    request: FILE_OPEN_DIALOG_REQUEST_SCHEMA,
    response: FILE_OPEN_DIALOG_RESPONSE_SCHEMA,
  },
  /**
   * TASK-028 §5/§11: журнал измерений — CRUD и список (арх. 05 §3, FR-1/FR-2).
   * Хендлеры подключают use cases TASK-029 (add), TASK-037 (update/delete), TASK-033
   * (list); флаги эвристик и критичность — в ответе add.
   */
  'measurements/add': {
    request: MEASUREMENT_ADD_REQUEST_SCHEMA,
    response: MEASUREMENT_ADD_RESPONSE_SCHEMA,
    secure: true,
  },
  'measurements/list': {
    request: MEASUREMENT_LIST_REQUEST_SCHEMA,
    response: MEASUREMENT_LIST_RESPONSE_SCHEMA,
    secure: true,
  },
  'measurements/update': {
    request: MEASUREMENT_UPDATE_REQUEST_SCHEMA,
    response: MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
    secure: true,
  },
  'measurements/delete': {
    request: MEASUREMENT_DELETE_REQUEST_SCHEMA,
    response: MEASUREMENT_DELETE_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-045 §5/§11: FTS-поиск заметок (арх. 05 §3, FR-2.2). Хендлер — use case
   * SearchNotes (TASK-045 §5/§9): мусорный/пустой запрос — пустой результат, не ошибка.
   */
  'notes/search': {
    request: NOTES_SEARCH_REQUEST_SCHEMA,
    response: NOTES_SEARCH_RESPONSE_SCHEMA,
    // TASK-094 §7: FTS-индекс в БД — secure.
    secure: true,
  },
  /**
   * TASK-047 §5/§11: настройки — prefs/get (полный документ) и prefs/set
   * {patch} → обновлённый полный. Patch — strip-режим (неизвестные ключи
   * отбрасываются zod, неверный тип — VALIDATION/FAILED); merge — в сервисе.
   */
  'prefs/get': {
    request: PREFS_GET_REQUEST_SCHEMA,
    response: PREFS_GET_RESPONSE_SCHEMA,
    // TASK-094 §7: prefs живут в app_setting (БД) — при locked читаются из закрытой БД.
    secure: true,
  },
  'prefs/set': {
    request: PREFS_SET_REQUEST_SCHEMA,
    response: PREFS_SET_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-098 §5/§11: журнал сети приватности — {limit=50} → {entries: desc по
   * at_utc, ops: перечень операций из EgressPolicy.ALLOWED с enabled-состоянием
   * согласий}. secure: чтение network_event (БД, §8); живая лента — инвалидация
   * рендерера по событию net:activity (§12).
   */
  'privacy/journal': {
    request: PRIVACY_JOURNAL_REQUEST_SCHEMA,
    response: PRIVACY_JOURNAL_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-098 §5/§14: согласия — {} → Consents (чтение) | {patch} → Consents
   * (переключение; patch строгий — неизвестный ключ VALIDATION, §14). ЕДИНСТВЕННЫЙ
   * канал изменения согласий (prefs direct-запись из UI запрещена — конвенция).
   * secure: prefs в app_setting (БД).
   */
  'privacy/consents': {
    request: PRIVACY_CONSENTS_REQUEST_SCHEMA,
    response: PRIVACY_CONSENTS_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-065 §5/§11: экспорт CSV/JSON (US-27) — {profileId} → {path} | {canceled: true}.
   * Путь файла выбирает save-диалог main (§14: renderer путь не присылает); отмена —
   * не ошибка (§7). Оба канала — одна пара схем (запрос одинаков, §5 «аналогично»).
   */
  'report/export-csv': {
    request: REPORT_EXPORT_REQUEST_SCHEMA,
    response: REPORT_EXPORT_RESPONSE_SCHEMA,
    secure: true,
  },
  'report/export-json': {
    request: REPORT_EXPORT_REQUEST_SCHEMA,
    response: REPORT_EXPORT_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-068 §5/§11: сборка+сохранение PDF-отчёта (UC-05) — {profileId, period,
   * includeAiSection, aiText?} → {path} | {canceled: true} (та же union-схема, §23).
   * Пустой период → REPORT/EMPTY_PERIOD (main-валидация, §9); путь — save-диалог main.
   */
  'report/pdf': {
    request: REPORT_PDF_REQUEST_SCHEMA,
    response: REPORT_PDF_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-051 §5/§11: активная справочная шкала — {} → полная форма ActiveScale
   * (code, version, sourceLabel, категории, обе заметки). Статический между
   * запусками (данные — из комплекта, §14): кэш рендерера staleTime Infinity.
   */
  'scales/active': {
    request: SCALES_ACTIVE_REQUEST_SCHEMA,
    response: SCALES_ACTIVE_RESPONSE_SCHEMA,
    // TASK-094 §7: reference_scale в БД — secure.
    secure: true,
  },
  /**
   * TASK-054 §5/§11: статистика периода поверх read models 052/053 —
   * {profileId, period} → {stats: PeriodStatisticsDto, scale: {code, version,
   * sourceLabel}}. Пустой период — полная структура с нулями/undefined, не ошибка
   * (§11); при insufficientData категория в данных отсутствует (EC-09). Период —
   * та же схема, что пойдёт в trend/series (§23: переиспользование обязательно).
   */
  'stats/period': {
    request: STATS_REQUEST_SCHEMA,
    response: STATS_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-056 §5/§11: серии точек для графика динамики — {profileId, period} →
   * {mode, points?|days?}: raw до порога RAW_POINTS_LIMIT (500) включительно, daily —
   * агрегация «день = среднее + диапазон» при превышении (порог и форма — в контракте,
   * §2). Пустой период — {mode:'raw', points:[]}, не ошибка (§11). Период — та же
   * схема, что у stats/period (§23 054: переиспользование обязательно).
   */
  'trend/series': {
    request: TREND_REQUEST_SCHEMA,
    response: TREND_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-096 §5/§11: обновления приложения (ручной режим electron-updater).
   * check {} → {status: available|latest|error, version?} — проверка ТОЛЬКО по
   * согласию updatesCheck (разрешение и журнал — EgressGateway.checkPermission,
   * §4; без согласия — NET/BLOCKED_BY_POLICY, журнал blocked); download {} → та
   * же форма статуса (финал ready|error; ход — событиями update:progress, §11 —
   * §23: одна схема на оба канала, прецедент report/export-*); install {} →
   * {restarting: true} — только по кнопке UI 097 (без скачанного — UPD/NOT_READY).
   */
  'updates/check': {
    request: UPDATES_CHECK_REQUEST_SCHEMA,
    response: UPDATES_STATUS_RESPONSE_SCHEMA,
    // TASK-094 §7: журнал разрешения/проверки gateway пишет в network_event (БД).
    secure: true,
  },
  'updates/download': {
    request: UPDATES_DOWNLOAD_REQUEST_SCHEMA,
    response: UPDATES_STATUS_RESPONSE_SCHEMA,
    secure: true,
  },
  'updates/install': {
    request: UPDATES_INSTALL_REQUEST_SCHEMA,
    response: UPDATES_INSTALL_RESPONSE_SCHEMA,
    secure: true,
  },
  /**
   * TASK-094 §5/§11: локальный вход (эпик 6.1) — статус/разблокировка/блокировка.
   * НЕ secure: минимальный входной набор, доступный при locked (vault/unlock и
   * есть выход из lock, §5 «повторный unlock открывает»).
   */
  'vault/status': {
    request: VAULT_STATUS_REQUEST_SCHEMA,
    response: VAULT_STATUS_RESPONSE_SCHEMA,
  },
  'vault/unlock': {
    request: VAULT_UNLOCK_REQUEST_SCHEMA,
    response: VAULT_UNLOCK_RESPONSE_SCHEMA,
  },
  'vault/lock': {
    request: VAULT_LOCK_REQUEST_SCHEMA,
    response: VAULT_LOCK_RESPONSE_SCHEMA,
  },
  /**
   * TASK-094 §5/§11 + РЕВЬЮ (§3/§14): управление паролем — только из открытой
   * сессии. secure: иначе в locked канал давал бы неthrottled-оракул того же
   * секрета (change/remove порта 093 полностью проверяют пароль Argon2id+GCM без
   * backoff) и молча перепаковывал бы vault.key на угаданный пароль. Гвардия
   * каркаса — единая точка; VaultService.setPassphrase дублирует отказ
   * VAULT/LOCKED (defense-in-depth для прямых вызовов сервиса).
   */
  'vault/set-passphrase': {
    request: VAULT_SET_PASSPHRASE_REQUEST_SCHEMA,
    response: VAULT_SET_PASSPHRASE_RESPONSE_SCHEMA,
    secure: true,
  },
} satisfies Record<ChannelName, ChannelSchemas>;
