/**
 * TASK-011 §5/§7/§17: хелперы клиентских ошибок рендерера.
 *
 * toUserMessage(AppErrorDto) — текст по каталогу i18n/ru/errors.json с fallback на
 * errors.internal: никакого «Error: undefined» (NFR-12); неизвестный ключ и ключ вне
 * errors.* показывают общий текст, не технический мусор (§20 п. 4). Полноценный
 * react-i18next + ICU-подстановки params придут с TASK-013 — форма каталога уже
 * совместима (ключи errors.*).
 *
 * computeDigest — хеш message+первой строки стека (§7) для дедупликации записей в
 * логах (§18): FNV-1a 32 бита, hex — детерминирован, ≤64 символов (§11/§14); без
 * node:crypto — в рендерере нет Node (арх. 08 §4).
 *
 * logClientError — fire-and-forget доставка отчёта в общий лог через канал
 * app/log-client-error (§9/§11): ошибки конверта/транспорта и отсутствие моста
 * глушатся — механизм логирования не ломает UI цепочкой (§13).
 */
import type { AppErrorDto, ChannelRequest } from '@hl/contracts';

import RU_ERRORS from '../i18n/ru/errors.json';
import { call } from '../src/lib/ipc';

/** Плоский каталог сообщений ошибок: ключ каталога (без префикса errors.) → текст. */
const CATALOG: Readonly<Record<string, string>> = RU_ERRORS;

/** Ключ fallback-сообщения (§17): всё неизвестное показывается как внутренняя ошибка. */
const FALLBACK_KEY = 'internal';

/** Код клиентского отчёта (§7: единственный допустимый литерал канала). */
export const RENDERER_ERROR_CODE = 'APP/RENDERER' as const;

/** Тип отчёта канала — выводится из реестра схем contracts (§23). */
export type ClientErrorReport = ChannelRequest<'app/log-client-error'>;

/** Текст ошибки для пользователя: по каталогу с fallback на errors.internal (§17). */
export function toUserMessage(error: AppErrorDto): string {
  return translateMessageKey(error.messageKey);
}

/** Резолв ключа каталога errors.*; неизвестный ключ → errors.internal (§20 п. 4). */
export function translateMessageKey(messageKey: string): string {
  if (messageKey.startsWith('errors.')) {
    const text = CATALOG[messageKey.slice('errors.'.length)];
    if (text !== undefined) {
      return text;
    }
  }
  const fallback = CATALOG[FALLBACK_KEY];
  return fallback === undefined ? '' : fallback;
}

/** FNV-1a 32 бита → 8 hex-символов (детерминированный digest, §7). */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Digest ошибки (§7): message + первая строка стека (кадр возникновения) — у двух
 * крашей в одном месте один digest, дедупликация в логах возможна без PHI в поле.
 */
export function computeDigest(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stackLines = error instanceof Error ? (error.stack ?? '').split('\n') : [];
  const stackFirstLine = stackLines.length > 1 ? (stackLines[1] ?? '').trim() : '';
  return fnv1a32(`${message}\n${stackFirstLine}`);
}

/**
 * Fire-and-forget доставка отчёта об ошибке рендерера в общий лог (§9/§18).
 * Любой сбой (моста, конверта, валидации) — глушится: канал не должен ронять UI.
 */
export function logClientError(report: ClientErrorReport): void {
  try {
    void call('app/log-client-error', report).catch(() => undefined);
  } catch {
    // мост недоступен (ранний краш до preload, тесты) — логирование не ломает UI
  }
}
