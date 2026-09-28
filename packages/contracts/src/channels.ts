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
 * серии графика `trend/series` — TASK-056 §5/§11 (схемы — trends.ts).
 *
 * `__bench/seed` — TASK-062 §9/§11/§14, TEST-ONLY: сидинг синтетики perf-bench.
 * Имя вне конвенции `домен/действие` намеренно (двойное подчёркивание — маркер
 * служебного канала); регистрация — только при env HL_BENCH=1 в не-packaged
 * запуске (гард benchChannelsEnabled, main §14). В контракте — только ФОРМА:
 * без флага канал не зарегистрирован и неотличим от неизвестного (APP/INTERNAL).
 */
export type ChannelName =
  | '__bench/seed'
  | 'app/ping'
  | 'app/log-client-error'
  | 'measurements/add'
  | 'measurements/list'
  | 'measurements/update'
  | 'measurements/delete'
  | 'notes/search'
  | 'prefs/get'
  | 'prefs/set'
  | 'scales/active'
  | 'stats/period'
  | 'trend/series';

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
