/**
 * TASK-008 §5: реестр zod-схем прикладных каналов — единственное место знания о
 * формах payload (арх. 05 §1). Схемы strict по умолчанию (§14: prototype-pollution);
 * типы выводятся из схем (z.infer) — никакой ручной синхронизации (§23).
 */
import { z } from 'zod';

import type { ChannelName } from './channels.js';

/** Пара схем канала: запрос валидируется в main до handler, ответ — контракт хендлера. */
export interface ChannelSchemas<TRequest = unknown, TResponse = unknown> {
  readonly request: z.ZodType<TRequest>;
  readonly response: z.ZodType<TResponse>;
}

/**
 * Реестр каналов: `Record<ChannelName, ChannelSchemas>` (§5). Новый канал = запись
 * здесь + строка в union ChannelName; компилятор не даст забыть ни одну из сторон.
 */
export const CHANNEL_SCHEMAS = {
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
} satisfies Record<ChannelName, ChannelSchemas>;
