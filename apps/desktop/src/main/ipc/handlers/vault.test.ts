// TASK-094 §11/§19: юниты тонких хендлеров vault/* (прецедент updates.test.ts):
// маппинг вызова канала на VaultService; валидацию payload делает каркас TASK-008,
// неудачи — AppError из хендлера (конверт отказа каркаса, §13 п. 3).
import { describe, expect, it, vi } from 'vitest';

import { AppError, err, ok } from '@hl/kernel';

import {
  createVaultLockHandler,
  createVaultSetPassphraseHandler,
  createVaultStatusHandler,
  createVaultUnlockHandler,
} from './vault.js';
import type { VaultService } from '../../modules/security/application/vault-service.js';

/** Fake-сервис: шпионы наружу переменными (unbound-method — методы класса не референсим). */
const makeService = (): {
  service: VaultService;
  getStatus: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
  setPassphrase: ReturnType<typeof vi.fn>;
} => {
  const getStatus = vi.fn(() => ({ mode: 'passphrase' as const, locked: true }));
  const unlock = vi.fn(() => Promise.resolve(ok({ ok: true as const })));
  const lock = vi.fn(() => ({ locked: true as const }));
  const setPassphrase = vi.fn(() =>
    Promise.resolve(ok({ mode: 'passphrase' as const })),
  );
  return {
    getStatus,
    unlock,
    lock,
    setPassphrase,
    service: { getStatus, unlock, lock, setPassphrase } as unknown as VaultService,
  };
};

describe('хендлеры vault/* (TASK-094 §11)', () => {
  it('vault/status → service.getStatus()', () => {
    const { service, getStatus } = makeService();
    expect(createVaultStatusHandler(service)({})).toEqual({
      mode: 'passphrase',
      locked: true,
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('vault/unlock → service.unlock(pass); успех — {ok: true}', async () => {
    const { service, unlock } = makeService();
    await expect(createVaultUnlockHandler(service)({ pass: 'пароль' })).resolves.toEqual({
      ok: true,
    });
    expect(unlock).toHaveBeenCalledWith('пароль');
  });

  it('vault/unlock: AppError сервиса уходит в конверт отказа (RateLimited/WrongPassphrase, §5)', async () => {
    const { service, unlock } = makeService();
    unlock.mockReturnValue(
      Promise.resolve(
        err(AppError.of('VAULT/RATE_LIMITED', 'errors.VAULT_RATE_LIMITED', { backoffSec: 2 })),
      ),
    );
    await expect(createVaultUnlockHandler(service)({ pass: 'x' })).rejects.toMatchObject({
      code: 'VAULT/RATE_LIMITED',
      params: { backoffSec: 2 },
    });
  });

  it('vault/lock → service.lock("manual"); ответ {locked}', () => {
    const { service, lock } = makeService();
    expect(createVaultLockHandler(service)({})).toEqual({ locked: true });
    expect(lock).toHaveBeenCalledWith('manual');
  });

  it.each([
    { action: 'set', pass: 'пароль' },
    { action: 'change', old: 'старый', new: 'новый' },
    { action: 'remove', old: 'старый' },
  ] as const)('vault/set-passphrase %j транзитом к сервису, ответ {mode}', async (command) => {
    const { service, setPassphrase } = makeService();
    await expect(createVaultSetPassphraseHandler(service)(command)).resolves.toEqual({
      mode: 'passphrase',
    });
    expect(setPassphrase).toHaveBeenCalledWith(command);
  });

  it('vault/set-passphrase: AppError порта уходит в конверт отказа (§19, консистентность с 093)', async () => {
    const { service, setPassphrase } = makeService();
    setPassphrase.mockReturnValue(
      Promise.resolve(
        err(AppError.of('VAULT/WRONG_PASSPHRASE', 'errors.VAULT_WRONG_PASSPHRASE')),
      ),
    );
    await expect(
      createVaultSetPassphraseHandler(service)({ action: 'change', old: 'а', new: 'б' }),
    ).rejects.toMatchObject({ code: 'VAULT/WRONG_PASSPHRASE' });
  });
});
