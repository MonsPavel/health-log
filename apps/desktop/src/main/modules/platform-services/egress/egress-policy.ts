/**
 * TASK-075 §5: EgressPolicy — белый список сетевых операций приложения (D11,
 * арх. 08 §5). Единственный источник «что можно»: EgressGateway отказывает в любой
 * операции вне ALLOWED — ДО обращения к сети (быстрый отказ, §9), с blocked-записью
 * в журнале (пользовательский журнал честен и про отказы, §9).
 *
 * Каждая операция связана с ключом согласия пользователя в prefs.netConsents
 * (contracts, TASK-047/075): согласие читается gateway'ем ТОЛЬКО для чтения (§14) —
 * отмена согласия мгновенно блокирует следующий запрос. UI согласий — TASK-081/099.
 *
 * Домен-allowlist пер-операции (пин домены в политике) — будущая работа §5
 * (ADR-0004, P7-аудит); TLS всегда — http-эндпоинтов в политике нет (§14).
 */
import type { NetConsents } from '@hl/contracts';

/** Имена операций белого списка (§5): обновления приложения и загрузка моделей. */
export const EGRESS_OPS = ['models.download', 'updates.check'] as const;

/** Имя сетевой операции (строкой приходит в request — проверка членства runtime, §13). */
export type EgressOp = (typeof EGRESS_OPS)[number];

/** Строка политики: каким ключом prefs.netConsents управляется операция (§5). */
export interface EgressPolicyEntry {
  /** Ключ согласия в prefs.netConsents (read-only для gateway, §14). */
  readonly consentKey: keyof NetConsents;
}

/**
 * ALLOWED (§5 дословно): карта «операция → строка политики». Расширяется только
 * задачей (белый список — код, не конфиг; аудит AC-4.1 — один файл).
 */
export const ALLOWED: Readonly<Record<EgressOp, EgressPolicyEntry>> = {
  'models.download': { consentKey: 'modelsDownload' },
  'updates.check': { consentKey: 'updatesCheck' },
};

/** Публичное имя политики (модуль egress): ALLOWED под EgressPolicy (§6). */
export const EgressPolicy = { ALLOWED } as const;

/** Ключ i18n-каталога для NET/BLOCKED_BY_POLICY (конвенция арх. 05 §29; тексты — TASK-101). */
export const NET_BLOCKED_BY_POLICY_MESSAGE_KEY = 'errors.NET_BLOCKED_BY_POLICY';
