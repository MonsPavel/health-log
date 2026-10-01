/**
 * TASK-095 §5/§11: контракт heartbeat-канала — сигнал пользовательской активности
 * рендерера для корректного автоблока (эпик 6.1). Рендерер шлёт `app/heartbeat`
 * на pointerdown/keydown с троттлом 30 с (§5); main продлевает окно автоблока —
 * VaultService.touchActivity (update lastActivity, §9). Канал НЕ secure: активность
 * продлевает сессию и в locked (инвентарь vault.test.ts — OPEN_CHANNELS), ответ null —
 * fire-and-forget (§9, прецедент app/reveal-path).
 *
 * Payload пуст — имя канала несёт смысл (§7: сигналы без значений); strict-запрос —
 * IPC-гигиена (§14, прецедент app/ping).
 */
import { z } from 'zod';

/** §11: `app/heartbeat {} → null` — без параметров. */
export const HEARTBEAT_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ null — канал fire-and-forget. */
export const HEARTBEAT_RESPONSE_SCHEMA = z.null();
