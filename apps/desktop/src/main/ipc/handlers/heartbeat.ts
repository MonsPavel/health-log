/**
 * Хендлер канала `app/heartbeat` (TASK-095 §5/§9/§11) — сигнал пользовательской
 * активности рендерера (pointerdown/keydown, троттл 30 с в UI) для корректного
 * автоблока: продлевает окно (VaultService.touchActivity) и отвечает null —
 * fire-and-forget (прецедент reveal.ts). Канал НЕ secure (инвентарь contracts):
 * активность продлевает сессию и в locked. Каркас TASK-008 и так зовёт onActivity
 * на каждый транспортный запрос (register-channel, §9 094) — явный touchActivity
 * здесь страхует прямой вызов хендлера и документирует контракт канала.
 */
import type { ChannelRequest, ChannelResponse } from '@hl/contracts';

import type { VaultService } from '../../modules/security/application/vault-service.js';

/** Фабрика хендлера `app/heartbeat`: активность → null (§11). */
export function createHeartbeatHandler(
  service: VaultService,
): (payload: ChannelRequest<'app/heartbeat'>) => ChannelResponse<'app/heartbeat'> {
  return () => {
    service.touchActivity();
    return null;
  };
}
