/**
 * TASK-008 §5/§11: имена каналов и транспортный контракт моста.
 *
 * Прикладные каналы — `домен/действие` (арх. 05 §2), union растит компилятор:
 * новый канал добавляется в ChannelName и в CHANNEL_SCHEMAS (schemas.ts).
 *
 * Транспорт: рендерер вызывает единственный зарегистрированный в main канал
 * `hl:invoke` с `{channel, payload}` (§13 п. 1 — «канал существует?» проверяет
 * каркас; у Electron нет hook на invoke незарегистрированного канала, поэтому
 * неизвестный канал обязан обнаруживаться в main — §11/§20: APP/INTERNAL + лог).
 */
import { z } from 'zod';

import type { CHANNEL_SCHEMAS } from './schemas.js';

/** Прикладные каналы (сейчас — только ping; прикладные — с TASK-028). */
export type ChannelName = 'app/ping';

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
  /** Подписка на событие main→renderer; возвращает отписку. Заготовка — шина в TASK-009. */
  on(name: string, listener: (payload: unknown) => void): () => void;
}

/** Тип запроса канала — выводится из реестра схем (z.infer, §23). */
export type ChannelRequest<C extends ChannelName> = z.output<
  (typeof CHANNEL_SCHEMAS)[C]['request']
>;

/** Тип ответа канала — выводится из реестра схем (z.infer, §23). */
export type ChannelResponse<C extends ChannelName> = z.output<
  (typeof CHANNEL_SCHEMAS)[C]['response']
>;
