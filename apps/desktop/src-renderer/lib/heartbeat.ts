/**
 * TASK-095 §5/§9: heartbeat пользовательской активности — сигнал для корректного
 * автоблока. Рендерер шлёт канал `app/heartbeat` на pointerdown/keydown (capture —
 * активность ловится на всём дереве, даже если событие где-то остановлено) с
 * троттлом 30 с (§5): при живой активности пауза между сигналами не превышает
 * интервал проверки автоблока main (30 с, AUTOLOCK_CHECK_INTERVAL_MS) — простой
 * не успевает накопиться; полная тишина → автоблок по порогу prefs.autoLockMin.
 *
 * Троттл — ведущий фронт (leading edge): первая активность шлёт немедленно,
 * повторы в окне 30 с глушатся. Чистая фабрика createHeartbeatSender — время
 * инъекцией (§19: детерминированные тесты); боевой хук useHeartbeat — слушатели
 * на window, отписка при unmount (§10, прецедент useHlEvent). Отказ канала
 * глушится — heartbeat не должен ронять UI (fire-and-forget, §9).
 */
import { useEffect } from 'react';

import { call } from '../src/lib/ipc';

/** Окно троттла heartbeat, мс (§5). */
export const HEARTBEAT_THROTTLE_MS = 30_000;

/**
 * Фабрика троттл-отправителя (§19): возвращает notify(), шлющий send() не чаще
 * раза в HEARTBEAT_THROTTLE_MS по часам now (инъекция — тесты).
 */
export function createHeartbeatSender(send: () => void, now: () => number = Date.now): () => void {
  let lastSentMs = Number.NEGATIVE_INFINITY;
  return () => {
    const ts = now();
    if (ts - lastSentMs >= HEARTBEAT_THROTTLE_MS) {
      lastSentMs = ts;
      send();
    }
  };
}

/** Слушатели активности — capture на window (§5: pointerdown/keydown). */
export function useHeartbeat(): void {
  useEffect(() => {
    const notify = createHeartbeatSender(() => {
      void call('app/heartbeat', {}).catch(() => undefined);
    });
    const onActivity = (): void => notify();
    window.addEventListener('pointerdown', onActivity, true);
    window.addEventListener('keydown', onActivity, true);
    return () => {
      window.removeEventListener('pointerdown', onActivity, true);
      window.removeEventListener('keydown', onActivity, true);
    };
  }, []);
}
