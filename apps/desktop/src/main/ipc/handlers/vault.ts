/**
 * Хендлеры каналов `vault/*` (TASK-094 §5/§11) — слой тонкий, прецедент updates.ts:
 * zod-валидацию запроса делает каркас TASK-008 до вызова хендлера; здесь — вызов
 * VaultService. Неудачи unlock/set-passphrase — AppError из хендлера → конверт
 * отказа каркаса (§13 п. 3): VAULT/WRONG_PASSPHRASE / VAULT/RATE_LIMITED (params
 * {backoffSec} — текст «Подождите N с», §17) / ошибки порта 093. Пароль в ответах
 * и логах не появляется (§14).
 */
import type {
  ChannelRequest,
  ChannelResponse,
} from '@hl/contracts';

import type { VaultService } from '../../modules/security/application/vault-service.js';

/** Фабрика хендлера `vault/status` (§11): снимок состояния сессии входа. */
export function createVaultStatusHandler(
  service: VaultService,
): (payload: ChannelRequest<'vault/status'>) => ChannelResponse<'vault/status'> {
  return () => service.getStatus();
}

/** Фабрика хендлера `vault/unlock` (§5): успех — {ok: true}, неудача — AppError. */
export function createVaultUnlockHandler(
  service: VaultService,
): (
  payload: ChannelRequest<'vault/unlock'>,
) => Promise<ChannelResponse<'vault/unlock'>> {
  return async (payload) => {
    const result = await service.unlock(payload.pass);
    if (!result.ok) {
      // Контракт §13 п. 3: неудача — AppError (конверт отказа каркаса);
      // правилу only-throw-error это объяснено здесь.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error;
    }
    return { ok: true };
  };
}

/** Фабрика хендлера `vault/lock` (§5): checkpoint+close БД, событие lock:engaged. */
export function createVaultLockHandler(
  service: VaultService,
): (payload: ChannelRequest<'vault/lock'>) => ChannelResponse<'vault/lock'> {
  return () => service.lock('manual');
}

/** Фабрика хендлера `vault/set-passphrase` (§5): set|change|remove → {mode}. */
export function createVaultSetPassphraseHandler(
  service: VaultService,
): (
  payload: ChannelRequest<'vault/set-passphrase'>,
) => Promise<ChannelResponse<'vault/set-passphrase'>> {
  return async (payload) => {
    const result = await service.setPassphrase(payload);
    if (!result.ok) {
      // Контракт §13 п. 3 (см. unlock выше).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error;
    }
    return { mode: result.value.mode };
  };
}
