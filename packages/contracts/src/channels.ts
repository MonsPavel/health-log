/**
 * TASK-008 §5/§11: имена каналов и транспортный контракт моста.
 *
 * Прикладные каналы — `домен/действие` (арх. 05 §2), union растит компилятор:
 * новый канал добавляется в ChannelName и в CHANNEL_SCHEMAS (schemas.ts).
 * prefs/get|set — TASK-047 §5/§11 (схемы — prefs/schemas.ts).
 *
 * Транспорт: рендерер вызывает единственный зарегистрированный в main канал
 * `hl:invoke` с `{channel, payload}` (§13 п. 1 — «канал существует?» проверяет
 * каркас; у Electron нет hook на invoke незарегистрированного канала, поэтому
 * неизвестный канал обязан обнаруживаться в main — §11/§20: APP/INTERNAL + лог).
 */
import { z } from 'zod';

import type { HlEventMap } from './events.js';
import type { CHANNEL_SCHEMAS } from './schemas.js';

/**
 * Прикладные каналы: `домен/действие` (арх. 05 §2). `app/log-client-error` — каркасный
 * канал доставки клиентских ошибок в общий лог (TASK-011 §5/§11). Каналы журнала
 * измерений — TASK-028 §5/§11 (схемы — measurement/schemas.ts; хендлеры — TASK-029/030/037);
 * FTS-поиск заметок `notes/search` — TASK-045 §5/§11 (схемы — notes/schemas.ts);
 * активная шкала `scales/active` — TASK-051 §5/§11 (схемы — scales.ts);
 * статистика периода `stats/period` — TASK-054 §5/§11 (схемы — stats/schemas.ts);
 * серии графика `trend/series` — TASK-056 §5/§11 (схемы — trends.ts);
 * создание копии `backup/create` — TASK-070 §6/§11 (схемы — data-care/schemas.ts;
 * канал-контракт здесь, регистрация хендлера с UI — TASK-073);
 * восстановление из копии `backup/restore` (двухфазный: plan → execute) — TASK-071
 * §6/§11 (схемы — data-care/schemas.ts; регистрация хендлера — TASK-073);
 * полное удаление данных `data/wipe` (двухфазный по phase: plan → execute) —
 * TASK-072 §6/§11 (схемы — data-care/schemas.ts; регистрация хендлера — TASK-073);
 * экспорт CSV/JSON `report/export-csv|export-json` — TASK-065 §5/§11 (схемы —
 * report/schemas.ts: запрос {profileId}, путь выбирает main-диалог — §14; ответ
 * {path} | {canceled: true} — отмена не ошибка, §7);
 * PDF-отчёт `report/pdf` — TASK-068 §5/§11 (запрос {profileId, period,
 * includeAiSection, aiText?} — период в готовых utcMs-границах, aiText — параметр
 * вызывающего; ответ — та же union {path}|{canceled:true}); открыть папку с файлом
 * `app/reveal-path` {path} → null (shell.showItemInFolder, §11);
 * выбор файла копии `file/open-dialog` — TASK-073 §6/§9/§11 (схемы — file.ts:
 * запрос {filters} — путь выбирает open-диалог main, §14; ответ — та же union
 * {path} | {canceled: true}, §7/§23);
 * витрина моделей `ai/models/*` — TASK-081 §5/§7/§11 (схемы — ai/models-channels.ts):
 * list {} → {models: ModelView[], ramTotalGb, uiLanguage} одним вызовом (§7);
 * download/pause/resume/reset {modelId} → форма статуса 080 (download/resume — финал
 * флоу, пауза/сброс — статус после операции); select {modelId} → {modelId}
 * (prefs.aiSettings.modelId, ensureModel — лениво при генерации 087, §9);
 * превью ИИ-контекста `ai/context/preview` — TASK-083 §5/§11 (схемы —
 * ai/context-channels.ts): {profileId, period, includeNotes} → {text, sections,
 * hash} (modelId резолвит main из prefs; text — PHI, в лог не пишется, §14);
 * резюме периода `ai/summary/generate` (стрим: ответ {requestId}, данные —
 * событиями ai:token + финал 'ai/summary/result') и `ai/summary/latest` (стейлс-
 * бейдж §12: {profileId, period} → {summary, stale}|undefined) — TASK-087 §5/§11/§12
 * (схемы — ai/summary-channels.ts); `ai/summary/delete-all` — «Очистить разборы»
 * (TASK-088 §5: {} → null — вызов порта deleteAll 087, подтверждение — в UI);
 * чат `ai/chat/send` (стрим: ответ {requestId}, данные — событиями ai:token +
 * финал 'ai/chat/result'), `ai/chat/list` (инициализация UI §12: {profileId,
 * limit} → {messages}) и `ai/chat/clear` (необратимая очистка истории §13:
 * {} → {cleared: true}, идемпотентен) — TASK-089 §5/§11 (схемы —
 * ai/chat-channels.ts; отмена хода — тот же `ai/cancel` по requestId);
 * обновления приложения `updates/check|download|install` — TASK-096 §5/§11
 * (схемы — updates.ts): check {} → {status, version?} (проверка ТОЛЬКО по
 * согласию prefs.netConsents.updatesCheck — разрешение/журнал через
 * EgressGateway.checkPermission, §4; без согласия — отказ
 * NET/BLOCKED_BY_POLICY); download {} → та же форма статуса (ход — событиями
 * update:progress, финал — update:ready); install {} → {restarting: true}
 * (только по кнопке UI 097; без скачанного обновления — отказ UPD/NOT_READY);
 * локальный вход `vault/status|unlock|lock|set-passphrase` — TASK-094 §5/§11
 * (схемы — vault.ts): статус {mode, locked, backoffSec?}; unlock {pass} →
 * {ok: true} (неудача — конверт отказа: VAULT/WRONG_PASSPHRASE / в окне backoff
 * VAULT/RATE_LIMITED с params {backoffSec}, §17); lock {} → {locked} (БД
 * закрывается — checkpoint+close); set-passphrase — union по action
 * {set, pass}|{change, old, new}|{remove, old} → {mode}. vault/status|unlock|lock
 * НЕ secure — минимальный входной набор, доступный при locked (иначе вход
 * невозможен); set-passphrase и БД-каналы помечены secure: true — гвардия
 * requireUnlocked каркаса (§7/§11, AC5; ревью: смена/снятие пароля в locked —
 * неthrottled-оракул секрета).
 *
 * `__bench/seed` — TASK-062 §9/§11/§14, TEST-ONLY: сидинг синтетики perf-bench.
 * Имя вне конвенции `домен/действие` намеренно (двойное подчёркивание — маркер
 * служебного канала); регистрация — только при env HL_BENCH=1 в не-packaged
 * запуске (гард benchChannelsEnabled, main §14). В контракте — только ФОРМА:
 * без флага канал не зарегистрирован и неотличим от неизвестного (APP/INTERNAL).
 */
export type ChannelName =
  | '__bench/seed'
  // TASK-081 §5/§11: витрина моделей — list одним вызовом (§7), управление
  // загрузкой и выбор активной модели (схемы — ai/models-channels.ts).
  | 'ai/models/list'
  | 'ai/models/download'
  | 'ai/models/pause'
  | 'ai/models/resume'
  | 'ai/models/reset'
  | 'ai/models/select'
  // TASK-083 §5/§11: превью ИИ-контекста (схемы — ai/context-channels.ts) —
  // нужен UI раньше резюме (§11 РЕШЕНИЕ: канал в объёме 083).
  | 'ai/context/preview'
  // TASK-087 §5/§11/§12: резюме периода — generate (стрим: ответ {requestId},
  // данные событиями + финал 'ai/summary/result') и latest (стейлс-бейдж, §12);
  // `ai/cancel` — отмена генерации по requestId (§5 п.5, арх. 05 §3; чат 089 — тот же).
  // TASK-088 §5: `ai/summary/delete-all` — «Очистить разборы» (deleteAll порта 087).
  | 'ai/summary/generate'
  | 'ai/summary/latest'
  | 'ai/summary/delete-all'
  // TASK-089 §5/§11: чат поверх данных (US-19) — send (стрим: ответ {requestId},
  // данные событиями ai:token + финал 'ai/chat/result'; вопрос ≥2 ≤500, §13/§14),
  // list (инициализация UI §12) и clear (необратимая очистка истории, §13).
  | 'ai/chat/send'
  | 'ai/chat/clear'
  | 'ai/chat/list'
  | 'ai/cancel'
  | 'app/ping'
  | 'app/log-client-error'
  | 'app/reveal-path'
  | 'backup/create'
  | 'backup/restore'
  | 'data/wipe'
  | 'file/open-dialog'
  | 'measurements/add'
  | 'measurements/list'
  | 'measurements/update'
  | 'measurements/delete'
  | 'notes/search'
  | 'prefs/get'
  | 'prefs/set'
  | 'report/export-csv'
  | 'report/export-json'
  | 'report/pdf'
  | 'scales/active'
  | 'stats/period'
  | 'trend/series'
  // TASK-096 §5/§11: обновления приложения — check/download/install (схемы —
  // updates.ts; ручной режим electron-updater за согласием, NFR-11).
  | 'updates/check'
  | 'updates/download'
  | 'updates/install'
  // TASK-094 §5/§11: локальный вход — статус/разблокировка/блокировка/пароль
  // (схемы — vault.ts; VaultService main; НЕ secure — статус/unlock/lock доступны
  // при locked; set-passphrase — secure, ревью §14).
  | 'vault/status'
  | 'vault/unlock'
  | 'vault/lock'
  | 'vault/set-passphrase';

/** Транспортный канал каркаса: не прикладной, в CHANNEL_SCHEMAS не входит. */
export const HL_INVOKE_CHANNEL = 'hl:invoke';

/** Форма запроса к транспортному каналу (недоверенный рендерер — валидация zod, §14). */
export const HL_INVOKE_REQUEST_SCHEMA = z
  .object({ channel: z.string(), payload: z.unknown() })
  .strict();

/** Мост `window.hl` — единственная точка доступа рендерера к main (§5, арх. 08 §4). */
export interface HlBridge {
  /** Вызов прикладного канала; ответ — конверт ApiEnvelope (проверить isApiEnvelope). */
  invoke(channel: ChannelName, payload: unknown): Promise<unknown>;
  /** Подписка на событие из HlEventMap (TASK-009 §5); возвращает функцию отписки. */
  on<K extends keyof HlEventMap>(name: K, listener: (payload: HlEventMap[K]) => void): () => void;
}

/** Тип запроса канала — выводится из реестра схем (z.infer, §23). */
export type ChannelRequest<C extends ChannelName> = z.output<
  (typeof CHANNEL_SCHEMAS)[C]['request']
>;

/** Тип ответа канала — выводится из реестра схем (z.infer, §23). */
export type ChannelResponse<C extends ChannelName> = z.output<
  (typeof CHANNEL_SCHEMAS)[C]['response']
>;
