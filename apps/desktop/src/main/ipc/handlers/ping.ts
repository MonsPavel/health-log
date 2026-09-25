/**
 * Канал `app/ping` (TASK-008 §11): первый прикладной канал каркаса — проверка
 * полного круга renderer → preload → main → renderer. Ответ `{pong: true, ts}`;
 * ts — время main (порт Clock kernel, детерминизм в тестах).
 */
import type { Clock } from '@hl/kernel';

/** Форма ответа ping — выводится из реестра схем (contracts.CHANNEL_SCHEMAS, §23). */
export interface PingResponse {
  readonly pong: true;
  /** Время ответа main, мс эпохи Unix (UTC). */
  readonly ts: number;
}

/** Фабрика хендлера ping:.Clock инжектируется — тесты фиксируют время (NFR-10). */
export function createPingHandler(clock: Clock): () => PingResponse {
  return () => ({ pong: true, ts: clock.nowMs() });
}
