/**
 * TASK-100 §5/§11: контракты сампроверки старта (self-check) и «О приложении»
 * (NFR-3/NFR-10: повреждение обнаруживается явно, версии видимы — источник правды
 * для recovery-экрана TASK-101 и диагпакета TASK-103).
 *
 *  - `SelfCheckReport` — ИММУТАБЕЛЬНЫЙ снимок старта (§7): {dbOk, schemaVersion,
 *    vaultMode, worker?, prefsOk, checkedAtUtc, startupMs}. Полная проверка —
 *    ОТДЕЛЬНЫЙ канал, стартовый отчёт не мутирует (§7);
 *  - `app/selfcheck {} → SelfCheckReport | null` — отчёт из памяти main; null —
 *    самчек ещё не выполнялся (старт в locked до unlock). НЕ secure: БД не читает,
 *    PHI/путей не содержит (§14 — безопасен для диагпакета 103);
 *  - `app/meta {} → {appVersion, schemaVersion, scale, model?}` — строки версий UI
 *    «О приложении» (приложение/схема БД/активная шкала code+version/модель
 *    id+version если есть — §5); model опционален («если есть»). НЕ secure — канал
 *    версий/режима: в recovery-режиме TASK-101 §9 остаётся в наборе доступных;
 *  - `app/integrity-full {} → {ok, details}` — полная проверка по кнопке
 *    (PRAGMA integrity_check; §4: quick_check — компромисс скорости, full — по
 *    кнопке). Secure — БД-канал (§7 TASK-094).
 *
 * Все схемы strict (§14 IPC-гигиены). vaultMode — зеркало порта KeyVault.getMode
 * (контейнер); worker.state — зеркало AiWorkerState (events.ts TASK-076). KEY_MISSING
 * в отчёт не попадает принципиально (§13: vault проверяется ДО открытия БД — отказ
 * уходит в диалог 011/101, самчек после открытия фиксирует только mode).
 */
import { z } from 'zod';

/**
 * Статус llm-воркера (§5 «worker-статус») — зеркало домена AiWorkerState
 * (contracts events.ts, TASK-076: starting → ready → busy; краш → restarting → failed).
 */
export const APP_WORKER_STATE_SCHEMA = z.enum([
  'starting',
  'ready',
  'busy',
  'restarting',
  'failed',
]);

/**
 * §5: снимок сампроверки старта. checkedAtUtc — мс эпохи (прецедент at_utc
 * privacy 098); startupMs — длительность сампроверки (компонент стартового
 * бюджета §15: ≤150 мс, замер в тесте). Поля — только факты/версии (§14).
 */
export const SELF_CHECK_REPORT_SCHEMA = z
  .object({
    /** PRAGMA quick_check: ok | corrupt (§4/§8). */
    dbOk: z.boolean(),
    /** Версия схемы БД из meta (свежая/нечитаемая — 0, «миграций не было»). */
    schemaVersion: z.number().int().min(0),
    /** Режим хранилища ключа (§13: фиксируется после открытия; KEY_MISSING сюда не доходит). */
    vaultMode: z.enum(['none', 'passphrase']),
    /** Статус llm-воркера на момент сампроверки (если ИИ-модуль в графе — §5). */
    worker: z.object({ state: APP_WORKER_STATE_SCHEMA }).strict().optional(),
    /** prefs-валидация: zod при чтении прошёл (флаг — §5). */
    prefsOk: z.boolean(),
    /** Момент сампроверки, мс эпохи UTC. */
    checkedAtUtc: z.number().int().min(0),
    /** Длительность сампроверки, мс (§15). */
    startupMs: z.number().int().min(0),
  })
  .strict();

/** §11: запрос app/selfcheck — {} (отчёт хранится в main). */
export const APP_SELFCHECK_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ app/selfcheck — снимок старта | null (самчек ещё не выполнялся). */
export const APP_SELFCHECK_RESPONSE_SCHEMA = SELF_CHECK_REPORT_SCHEMA.nullable();

/** §11: запрос app/meta — {}. */
export const APP_META_REQUEST_SCHEMA = z.object({}).strict();

/**
 * §5/§11: версии для «О приложении» — appVersion (манифест), schemaVersion (БД),
 * активная шкала code+version, активная модель id+version (опционально — не выбрана).
 */
export const APP_META_RESPONSE_SCHEMA = z
  .object({
    appVersion: z.string().min(1),
    schemaVersion: z.number().int().min(0),
    scale: z
      .object({ code: z.string().min(1), version: z.string().min(1) })
      .strict(),
    model: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict().optional(),
  })
  .strict();

/** §11: запрос app/integrity-full — {} (progress не нужен: <10 с, §11). */
export const APP_INTEGRITY_FULL_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ app/integrity-full — {ok, details}: вывод PRAGMA integrity_check. */
export const APP_INTEGRITY_FULL_RESPONSE_SCHEMA = z
  .object({ ok: z.boolean(), details: z.string() })
  .strict();

/** Снимок сампроверки старта (z.infer — §23). */
export type SelfCheckReport = z.infer<typeof SELF_CHECK_REPORT_SCHEMA>;

/** Статус llm-воркера в отчёте (зеркало AiWorkerState). */
export type AppWorkerStateDto = z.infer<typeof APP_WORKER_STATE_SCHEMA>;

/** Запрос app/selfcheck. */
export type AppSelfcheckRequest = z.infer<typeof APP_SELFCHECK_REQUEST_SCHEMA>;

/** Ответ app/selfcheck. */
export type AppSelfcheckResponse = z.infer<typeof APP_SELFCHECK_RESPONSE_SCHEMA>;

/** Запрос app/meta. */
export type AppMetaRequest = z.infer<typeof APP_META_REQUEST_SCHEMA>;

/** Ответ app/meta — версии «О приложении». */
export type AppMetaResponse = z.infer<typeof APP_META_RESPONSE_SCHEMA>;

/** Запрос app/integrity-full. */
export type AppIntegrityFullRequest = z.infer<typeof APP_INTEGRITY_FULL_REQUEST_SCHEMA>;

/** Ответ app/integrity-full — результат полной проверки. */
export type AppIntegrityFullResponse = z.infer<typeof APP_INTEGRITY_FULL_RESPONSE_SCHEMA>;
