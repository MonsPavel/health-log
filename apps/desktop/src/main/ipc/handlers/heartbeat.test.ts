// TASK-095 §9/§11/§19: юнит тонкого хендлера `app/heartbeat` (прецедент vault.test.ts):
// вызов канала продлевает окно автоблока (VaultService.touchActivity) и отвечает null
// (fire-and-forget, §9). Валидацию payload делает каркас TASK-008; гвардии secure у
// канала нет — активность продлевает сессию и в locked (инвентарь contracts).
import { describe, expect, it, vi } from 'vitest';

import { createHeartbeatHandler } from './heartbeat.js';
import type { VaultService } from '../../modules/security/application/vault-service.js';

describe('хендлер app/heartbeat (TASK-095 §9/§11)', () => {
  it('вызывает vaultService.touchActivity() и отвечает null', () => {
    const touchActivity = vi.fn();
    const service = { touchActivity } as unknown as VaultService;

    expect(createHeartbeatHandler(service)({})).toBeNull();
    expect(touchActivity).toHaveBeenCalledTimes(1);
    expect(touchActivity).toHaveBeenCalledWith();
  });
});
