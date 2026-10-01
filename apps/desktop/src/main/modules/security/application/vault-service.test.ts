// TASK-094 §13/§19/§20: юниты VaultService на детерминированных часах (прецедент
// StepClock passphrase-crypto.test.ts): backoff-экспонента (AC1), сброс при успехе
// (AC2), lock (checkpoint+close через порт closeDatabase + событие lock:engaged),
// автоблок-пороги 5/15/60/0 и «активность продлевает» (AC4), задача session.autolock.
import { describe, expect, it, vi } from 'vitest';

import { AppError, err, ok, type Clock, type Result } from '@hl/kernel';
import { PREFS_SCHEMA } from '@hl/contracts';

import {
  AUTOLOCK_CHECK_INTERVAL_MS,
  AUTOLOCK_JOB_NAME,
  MAX_BACKOFF_SEC,
  VaultService,
  backoffDelaySec,
  createAutolockJob,
  VAULT_RATE_LIMITED_MESSAGE_KEY,
  type VaultNotify,
} from './vault-service.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  VAULT_WRONG_PASSPHRASE_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type VaultMode,
} from './ports/key-vault.js';

/**
 * Детерминированные часы с ручным продвижением (§19: время — порт; фиксированное
 * «сейчас» двигает тест — эквивалент FixedClock с tick, NFR-10).
 */
class AdvanceClock implements Clock {
  constructor(
    private ms: number,
    private readonly tz = 180,
  ) {}

  nowMs(): number {
    return this.ms;
  }

  tzOffsetMin(): number {
    return this.tz;
  }

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

/** Логгер-шпион (§18: проверяем факты и отсутствие пароля в метаданных, §14). */
const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/** Мок KeyVault (§19, прецедент MockVault): режим и исход unlock управляются тестом. */
const makeVault = (initialMode: VaultMode) => {
  let mode: VaultMode = initialMode;
  const impl = {
    ensureKey: vi.fn((): Promise<Result<EnsuredKey, AppError>> =>
      Promise.resolve(ok({ keyHex: 'ab'.repeat(32), created: false })),
    ),
    exportKeyForBackup: vi.fn((): Promise<Result<{ v: 2; wrappedB64: string; createdUtc: number }, AppError>> =>
      Promise.resolve(err(AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY))),
    ),
    setPassphrase: vi.fn((): Promise<Result<void, AppError>> => {
      mode = 'passphrase';
      return Promise.resolve(ok(undefined));
    }),
    changePassphrase: vi.fn((): Promise<Result<void, AppError>> => Promise.resolve(ok(undefined))),
    removePassphrase: vi.fn((): Promise<Result<void, AppError>> => {
      mode = 'none';
      return Promise.resolve(ok(undefined));
    }),
    unlock: vi.fn((): Promise<Result<void, AppError>> => Promise.resolve(ok(undefined))),
    getMode: (): VaultMode => mode,
  };
  return { impl, vault: impl as unknown as KeyVault };
};

/** Сборка сервиса с подстановками (§19); возвращает шпионы для ассертов. */
const makeService = (
  vaultMode: VaultMode,
  clock: AdvanceClock,
  overrides: {
    openDatabase?: () => Promise<Result<void, AppError>>;
    closeDatabase?: () => void;
    getAutoLockMin?: () => Promise<number>;
  } = {},
) => {
  const { vault, impl } = makeVault(vaultMode);
  const openDatabase = overrides.openDatabase ?? vi.fn(() => Promise.resolve(ok(undefined)));
  const closeDatabase = overrides.closeDatabase ?? vi.fn();
  const notify: VaultNotify = vi.fn();
  const logger = makeLogger();
  const getAutoLockMin = overrides.getAutoLockMin ?? vi.fn(() => Promise.resolve(5));
  const service = new VaultService({
    vault,
    openDatabase,
    closeDatabase,
    notify,
    clock,
    logger,
    getAutoLockMin,
  });
  return { service, vault: impl, openDatabase, closeDatabase, notify, logger, getAutoLockMin };
};

const WRONG = AppError.of('VAULT/WRONG_PASSPHRASE', VAULT_WRONG_PASSPHRASE_MESSAGE_KEY);

/** Полный документ prefs для ctx задачи (autoLockMin — единственное значимое поле). */
const prefsWith = (autoLockMin: number): ReturnType<typeof PREFS_SCHEMA.parse> =>
  PREFS_SCHEMA.parse({ autoLockMin });

const MIN = 60_000;

describe('VaultService — статус (§5: {mode, locked, backoffSec?})', () => {
  it('mode=none: всегда {mode: "none", locked: false}, без backoffSec; lock:required нет', () => {
    const { service, notify } = makeService('none', new AdvanceClock(1_000));
    expect(service.getStatus()).toEqual({ mode: 'none', locked: false });
    expect(notify).not.toHaveBeenCalled(); // старт незаблокированным — события нет
  });

  it('mode=passphrase при старте: {mode: "passphrase", locked: true} + lock:required (§5, §12)', () => {
    const { service, notify } = makeService('passphrase', new AdvanceClock(1_000));
    expect(service.getStatus()).toEqual({ mode: 'passphrase', locked: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('lock:required', {});
  });

  it('после unlock: locked=false; после lock: locked=true', async () => {
    const { service } = makeService('passphrase', new AdvanceClock(1_000));
    await expect(service.unlock('пароль')).resolves.toEqual(ok({ ok: true as const }));
    expect(service.getStatus()).toEqual({ mode: 'passphrase', locked: false });
    service.lock('manual');
    expect(service.getStatus()).toEqual({ mode: 'passphrase', locked: true });
  });

  it('в окне backoff статус несёт backoffSec (остаток, округление вверх, §17)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x');
    await service.unlock('x');
    await service.unlock('x'); // 3-я неудача → backoff 1 с
    clock.advance(200);
    expect(service.getStatus()).toEqual({ mode: 'passphrase', locked: true, backoffSec: 1 });
  });
});

describe('VaultService — backoff-экспонента (§4/AC1: N-я неудача → 2^(N−3) с, максимум 60)', () => {
  it('таблица задержек: 1-я/2-я — 0 (backoff с 3-й, §13), 3-я — 1, 4-я — 2, 5-я — 4', () => {
    expect(backoffDelaySec(1)).toBe(0);
    expect(backoffDelaySec(2)).toBe(0);
    expect(backoffDelaySec(3)).toBe(1);
    expect(backoffDelaySec(4)).toBe(2);
    expect(backoffDelaySec(5)).toBe(4);
  });

  it('экспонента продолжается и упирается в максимум 60 с (§4)', () => {
    expect(backoffDelaySec(6)).toBe(8);
    expect(backoffDelaySec(8)).toBe(32);
    expect(backoffDelaySec(9)).toBe(MAX_BACKOFF_SEC); // 2^6 = 64 → 60
    expect(backoffDelaySec(50)).toBe(MAX_BACKOFF_SEC);
  });

  it('поведение: 2-я неудача не ставит backoff; 3-я ставит 1 с, 4-я попытка в окне — отказ (§13)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));

    await service.unlock('x');
    await service.unlock('x');
    expect(service.getStatus().backoffSec).toBeUndefined(); // 2-я — ещё без backoff

    await service.unlock('x');
    expect(service.getStatus().backoffSec).toBe(1); // 3-я → 1 с
    // 4-я попытка в окне backoff — отказ RATE_LIMITED c backoffSec, пароль не проверяется.
    const refused = await service.unlock('x');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('VAULT/RATE_LIMITED');
      expect(refused.error.messageKey).toBe(VAULT_RATE_LIMITED_MESSAGE_KEY);
      expect(refused.error.params).toEqual({ backoffSec: 1 });
    }
    expect(vault.unlock).toHaveBeenCalledTimes(3); // отказанная попытка пароль не проверяла
  });

  it('отказанная в backoff попытка не увеличивает счётчик (после окна — проверка идёт)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x');
    await service.unlock('x');
    await service.unlock('x'); // attempts=3, backoff 1 с
    clock.advance(300);
    await service.unlock('x'); // отказана, счётчик остался 3
    clock.advance(700); // ровно конец окна — попытка проходит
    const next = await service.unlock('x'); // 4-я УЧТЁННАЯ неудача → backoff 2 с
    expect(next.ok).toBe(false);
    expect(service.getStatus().backoffSec).toBe(2);
  });
});

describe('VaultService — unlock (§13: успех → сброс; §9: unlock → открытие БД)', () => {
  it('неверный пароль: err VAULT/WRONG_PASSPHRASE, warn-лог с attempts БЕЗ пароля (§14/§18)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault, openDatabase, logger } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));

    const result = await service.unlock('секрет-пароль');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.messageKey).toBe(VAULT_WRONG_PASSPHRASE_MESSAGE_KEY);
    }
    expect(openDatabase).not.toHaveBeenCalled(); // БД не открывается (§9)
    expect(logger.warn).toHaveBeenCalledWith('vault unlock failed', { attempts: 1, backoffSec: 0 });
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('секрет-пароль');
  });

  it('сброс счётчика успешным unlock наблюдаем: после успеха+lock неудачи снова с начала (AC2)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault, logger } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x');
    await service.unlock('x'); // attempts=2
    vault.unlock.mockReturnValue(Promise.resolve(ok(undefined)));
    await service.unlock('верный'); // сброс → attempts=0
    service.lock('manual'); // lock счётчик не трогает — сброс сделал только успех
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x'); // если бы сброса не было — attempts=3 и backoff 1 с
    expect(logger.warn).toHaveBeenLastCalledWith('vault unlock failed', {
      attempts: 1,
      backoffSec: 0,
    });
  });

  it('успех: сброс attempts/backoff (AC2), открытие БД, info-лог', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault, openDatabase, logger } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x');
    await service.unlock('x');
    await service.unlock('x'); // attempts=3, backoff 1 с

    clock.advance(1_000); // окно истекло
    vault.unlock.mockReturnValue(Promise.resolve(ok(undefined)));
    const result = await service.unlock('верный');
    expect(result).toEqual(ok({ ok: true as const }));
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('vault unlock ok');
    // Сброс: окно backoff очищено немедленно (AC2).
    expect(service.getStatus().backoffSec).toBeUndefined();
  });

  it('сброс счётчика успешным unlock наблюдаем: после успеха+lock неудачи снова с начала (AC2)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault, logger } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x');
    await service.unlock('x'); // attempts=2
    vault.unlock.mockReturnValue(Promise.resolve(ok(undefined)));
    await service.unlock('верный'); // сброс → attempts=0
    service.lock('manual'); // lock счётчик не трогает — сброс сделал только успех
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x'); // если бы сброса не было — attempts=3 и backoff 1 с
    expect(logger.warn).toHaveBeenLastCalledWith('vault unlock failed', {
      attempts: 1,
      backoffSec: 0,
    });
  });

  it('успешный unlock при отказе открытия БД отдаёт ошибку открытия (STORAGE/*)', async () => {
    const clock = new AdvanceClock(1_000);
    const openError = AppError.of('STORAGE/CORRUPT', 'errors.STORAGE_CORRUPT');
    const { service } = makeService('passphrase', clock, {
      openDatabase: vi.fn(() => Promise.resolve(err(openError))),
    });
    const result = await service.unlock('верный');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORAGE/CORRUPT');
    }
  });

  it('mode=none: unlock — no-op ok, проверка пароля и открытие не нужны', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault, openDatabase } = makeService('none', clock);
    await expect(service.unlock('что-угодно')).resolves.toEqual(ok({ ok: true as const }));
    expect(vault.unlock).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('повторный unlock при разблокированной сессии — ok (идемпотентен)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service } = makeService('passphrase', clock);
    await service.unlock('пароль');
    await expect(service.unlock('пароль')).resolves.toEqual(ok({ ok: true as const }));
  });
});

describe('VaultService — lock (§5: БД закрывается checkpoint+close; события)', () => {
  it('ручной lock: closeDatabase, событие lock:engaged, лог с причиной manual (§18)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, closeDatabase, notify, logger } = makeService('passphrase', clock);
    await service.unlock('пароль');
    closeDatabase.mockClear();
    notify.mockClear();

    service.lock('manual');
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('lock:engaged', {});
    expect(logger.info).toHaveBeenCalledWith('vault lock engaged', { reason: 'manual' });
  });

  it('повторный lock идемпотентен (closeDatabase один раз)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, closeDatabase } = makeService('passphrase', clock);
    await service.unlock('пароль');
    service.lock('manual');
    service.lock('manual');
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('lock не сбрасывает окно backoff — перебор остаётся замедленным и в locked (§5)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('passphrase', clock);
    vault.unlock.mockReturnValue(Promise.resolve(err(WRONG)));
    await service.unlock('x');
    await service.unlock('x');
    await service.unlock('x'); // attempts=3, backoff 1 с
    service.lock('manual'); // БД закрывается, окно backoff сохраняется
    clock.advance(200);
    expect(service.getStatus().backoffSec).toBe(1);
    const refused = await service.unlock('x'); // попытка в окне — отказ и без БД
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('VAULT/RATE_LIMITED');
    }
  });

  it('mode=none: lock — no-op (закрывать нечего, события нет)', () => {
    const clock = new AdvanceClock(1_000);
    const { service, closeDatabase, notify } = makeService('none', clock);
    expect(service.lock('manual')).toEqual({ locked: false });
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('VaultService — автоблок (§9/AC4: порог из prefs, активность продлевает)', () => {
  it('порог 5 мин: 4:59 — нет блокировки, 5:00 — lock (closeDatabase + событие + лог autolock)', async () => {
    const clock = new AdvanceClock(0);
    const { service, closeDatabase, notify, logger } = makeService('passphrase', clock);
    await service.unlock('пароль');
    closeDatabase.mockClear();
    notify.mockClear();

    clock.advance(5 * MIN - 1_000);
    await service.checkAutolock();
    expect(closeDatabase).not.toHaveBeenCalled();

    clock.advance(1_000);
    await service.checkAutolock();
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('lock:engaged', {});
    expect(logger.info).toHaveBeenCalledWith('vault lock engaged', { reason: 'autolock' });
  });

  it('активность продлевает: touchActivity на 4:59 сдвигает порог (AC4)', async () => {
    const clock = new AdvanceClock(0);
    const { service } = makeService('passphrase', clock);
    await service.unlock('пароль');

    clock.advance(4 * MIN + 59_000);
    service.touchActivity(); // активность на 4:59
    clock.advance(4 * MIN + 59_000); // ещё 4:59 после неё
    await service.checkAutolock();
    expect(service.getStatus().locked).toBe(false);

    clock.advance(1_000); // 5:00 простоя
    await service.checkAutolock();
    expect(service.getStatus().locked).toBe(true);
  });

  it.each([
    [15, 14],
    [60, 59],
  ] as const)('порог %i мин: на %i-й минуте блокировки нет, на пороге — есть', async (threshold, before) => {
    const clock = new AdvanceClock(0);
    const { service } = makeService('passphrase', clock, {
      getAutoLockMin: vi.fn(() => Promise.resolve(threshold)),
    });
    await service.unlock('пароль');

    clock.advance(before * MIN);
    await service.checkAutolock();
    expect(service.getStatus().locked).toBe(false);
    clock.advance(1 * MIN);
    await service.checkAutolock();
    expect(service.getStatus().locked).toBe(true);
  });

  it('autoLockMin=0 — автоблок выключен (10 часов простоя — блокировки нет, §22)', async () => {
    const clock = new AdvanceClock(0);
    const { service, closeDatabase } = makeService('passphrase', clock, {
      getAutoLockMin: vi.fn(() => Promise.resolve(0)),
    });
    await service.unlock('пароль');
    clock.advance(10 * 60 * MIN);
    await service.checkAutolock();
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('locked — no-op до чтения prefs (§9; БД закрыта — читать autoLockMin нечем)', async () => {
    const clock = new AdvanceClock(0);
    const getAutoLockMin = vi.fn(() => Promise.resolve(5));
    const { service } = makeService('passphrase', clock, { getAutoLockMin });
    // Сессия не разблокирована — locked: checkAutolock не должен ни читать prefs, ни падать.
    clock.advance(10 * 60 * MIN);
    await expect(service.checkAutolock()).resolves.toBeUndefined();
    expect(getAutoLockMin).not.toHaveBeenCalled();
  });

  it('mode=none — автоблок не применяется (блокировать нечего)', async () => {
    const clock = new AdvanceClock(0);
    const { service, closeDatabase } = makeService('none', clock);
    clock.advance(10 * 60 * MIN);
    await service.checkAutolock();
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('отказ чтения prefs изолирован: checkAutolock не бросает (таймер живёт, §9)', async () => {
    const clock = new AdvanceClock(0);
    const { service, closeDatabase } = makeService('passphrase', clock, {
      getAutoLockMin: vi.fn(() => Promise.reject(new Error('prefs недоступны'))),
    });
    await service.unlock('пароль');
    clock.advance(10 * 60 * MIN);
    await expect(service.checkAutolock()).resolves.toBeUndefined();
    expect(closeDatabase).not.toHaveBeenCalled();
  });
});

describe('createAutolockJob (§5: JobScheduler-задача session.autolock)', () => {
  it('имя session.autolock, интервал проверки 30 с', () => {
    const job = createAutolockJob({ service: { lockIfIdle: vi.fn() } });
    expect(job.name).toBe(AUTOLOCK_JOB_NAME);
    expect(AUTOLOCK_JOB_NAME).toBe('session.autolock');
    expect(job.intervalMs).toBe(AUTOLOCK_CHECK_INTERVAL_MS);
    expect(AUTOLOCK_CHECK_INTERVAL_MS).toBe(30_000);
  });

  it('run делегирует lockIfIdle(now, autoLockMin из ctx.prefs) и не возвращает действия', () => {
    const lockIfIdle = vi.fn();
    const job = createAutolockJob({ service: { lockIfIdle } });
    const now = { utcMs: 1_758_816_000_000, tzOffsetMin: 180 };
    expect(job.run({ prefs: prefsWith(15), now })).toBeNull();
    expect(lockIfIdle).toHaveBeenCalledWith(now.utcMs, 15);
  });

  it('run при autoLockMin=0 молчит (выкл, §22)', () => {
    const lockIfIdle = vi.fn();
    const job = createAutolockJob({ service: { lockIfIdle } });
    const now = { utcMs: 1_758_816_000_000, tzOffsetMin: 180 };
    expect(job.run({ prefs: prefsWith(0), now })).toBeNull();
    expect(lockIfIdle).not.toHaveBeenCalled();
  });
});

describe('VaultService — setPassphrase (§5: {pass|old+new|remove}; §19: консистентность с 093)', () => {
  it('set → vault.setPassphrase(pass), ответ {mode: "passphrase"}', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('none', clock);
    await expect(service.setPassphrase({ action: 'set', pass: 'пароль' })).resolves.toEqual(
      ok({ mode: 'passphrase' as const }),
    );
    expect(vault.setPassphrase).toHaveBeenCalledWith('пароль');
  });

  it('change → vault.changePassphrase(old, new); remove → vault.removePassphrase(old) и {mode: "none"}', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('passphrase', clock);
    await service.setPassphrase({ action: 'change', old: 'старый', new: 'новый' });
    expect(vault.changePassphrase).toHaveBeenCalledWith('старый', 'новый');
    await expect(service.setPassphrase({ action: 'remove', old: 'новый' })).resolves.toEqual(
      ok({ mode: 'none' as const }),
    );
    expect(vault.removePassphrase).toHaveBeenCalledWith('новый');
  });

  it('ошибка порта проходит наружу как есть (WRONG_PASSPHRASE при change, §13 093)', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault } = makeService('passphrase', clock);
    vault.changePassphrase.mockReturnValue(
      Promise.resolve(
        err(AppError.of('VAULT/WRONG_PASSPHRASE', VAULT_WRONG_PASSPHRASE_MESSAGE_KEY)),
      ),
    );
    const result = await service.setPassphrase({ action: 'change', old: 'неверный', new: 'новый' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VAULT/WRONG_PASSPHRASE');
    }
  });

  it('после remove сессия не блокируется: lock — no-op без событий', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, closeDatabase, notify } = makeService('passphrase', clock);
    await service.unlock('пароль');
    await service.setPassphrase({ action: 'remove', old: 'пароль' });
    closeDatabase.mockClear();
    notify.mockClear();
    expect(service.lock('manual')).toEqual({ locked: false });
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('VaultService — повторный вход (§5: повторный unlock открывает; §8)', () => {
  it('unlock после lock снова проверяет пароль и переоткрывает БД', async () => {
    const clock = new AdvanceClock(1_000);
    const { service, vault, openDatabase, closeDatabase } = makeService('passphrase', clock);
    await service.unlock('пароль');
    service.lock('manual');
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    openDatabase.mockClear();

    vault.unlock.mockReturnValueOnce(Promise.resolve(err(WRONG)));
    expect((await service.unlock('неверный')).ok).toBe(false); // пароль обязателен
    expect(openDatabase).not.toHaveBeenCalled();

    await service.unlock('пароль');
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(service.getStatus().locked).toBe(false);
  });
});
