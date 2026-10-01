/**
 * TASK-094 §5/§11: контракты каналов `vault/*` — сессионная механика локального
 * входа (эпик 6.1, FR-7.5). Хендлеры — ipc/handlers/vault.ts (main), состояние —
 * VaultService (main/modules/security/application). Ошибки unlock идут конвертом
 * отказа каркаса: VAULT/WRONG_PASSPHRASE (неверный пароль, 093) и
 * VAULT/RATE_LIMITED (окно backoff — params {backoffSec} для текста «Подождите
 * N с», §17); доступ к БД-каналам при locked — VAULT/LOCKED (гвардия requireUnlocked).
 *
 * Пароль min 8 — политика UI (TASK-095, §14 «крипто-агностик», прецедент 093);
 * здесь только отсечение пустой строки — Argon2id на заведомо пустом вводе не
 * запускаем (VALIDATION/FAILED каркаса).
 */
import { z } from 'zod';

import type { AppErrorDto } from './app-error-dto.js';

/** Режим защиты vault-а (§5: форма статуса; соответствует VaultMode порта 093). */
export type VaultProtectionMode = 'none' | 'passphrase';

/** §5: vault/status {} → {mode, locked, backoffSec?}. backoffSec — остаток backoff (сек, ≥1); вне окна поле отсутствует. */
export const VAULT_STATUS_REQUEST_SCHEMA = z.object({}).strict();

export const VAULT_STATUS_RESPONSE_SCHEMA = z
  .object({
    mode: z.enum(['none', 'passphrase']),
    locked: z.boolean(),
    backoffSec: z.number().int().min(1).optional(),
  })
  .strict();

/** §5: vault/unlock {pass} → {ok: true}; неудача — AppError-конверт (не в data). */
export const VAULT_UNLOCK_REQUEST_SCHEMA = z.object({ pass: z.string().min(1) }).strict();

export const VAULT_UNLOCK_RESPONSE_SCHEMA = z.object({ ok: z.literal(true) }).strict();

/** §5: vault/lock {} → {locked} — результирующее состояние (mode=none — no-op, locked:false). */
export const VAULT_LOCK_REQUEST_SCHEMA = z.object({}).strict();

export const VAULT_LOCK_RESPONSE_SCHEMA = z.object({ locked: z.boolean() }).strict();

/**
 * §5: vault/set-passphrase {pass|old+new|remove} — union по action:
 * set (включить пароль), change (сменить: old+new), remove (снять: old).
 * Маппинг на порт 093 — setPassphrase/changePassphrase/removePassphrase (§19:
 * консистентность с 093).
 */
export const VAULT_SET_PASSPHRASE_REQUEST_SCHEMA = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), pass: z.string().min(1) }).strict(),
  z
    .object({ action: z.literal('change'), old: z.string().min(1), new: z.string().min(1) })
    .strict(),
  z.object({ action: z.literal('remove'), old: z.string().min(1) }).strict(),
]);

/** §5: ответ — новый режим защиты (set → passphrase, remove → none, change — без смены). */
export const VAULT_SET_PASSPHRASE_RESPONSE_SCHEMA = z
  .object({ mode: z.enum(['none', 'passphrase']) })
  .strict();

/**
 * TASK-094 §7/§11: ключ каталога и DTO ошибки гвардии requireUnlocked — ЕДИНЫЙ
 * источник строки для каркаса (register-channel) и порта 093 (key-vault.ts
 * реэкспортирует ключ отсюда; конвенция арх. 05 §29).
 */
export const VAULT_LOCKED_MESSAGE_KEY = 'errors.VAULT_LOCKED';

/** DTO отказа secure-канала в locked-состоянии (конверт каркаса, §13). */
export const VAULT_LOCKED_ERROR: AppErrorDto = {
  code: 'VAULT/LOCKED',
  messageKey: VAULT_LOCKED_MESSAGE_KEY,
};
