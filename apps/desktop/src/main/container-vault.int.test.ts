// TASK-094 §19/§20: интеграция vault-механики через КАННАЛЫ контейнера (§19 —
// консистентность с 093): lock → файлы -wal/-shm исчезли (AC3, тест ФС) → БД-канал
// → VAULT/LOCKED (гвардия requireUnlocked) → unlock → данные читаются; backoff
// unlock'а виден в конвертах канала (RATE_LIMITED + backoffSec, §17); события
// lock:engaged/lock:required доставляются мосту renderer'а (AC6); автоблок 5 мин
// с продлением активностью (AC4) — на общих с контейнером часах; set-passphrase
// поток через каналы (смена пароля — переобёртка, §13 093).
//
// Vault — боевой SafeStorageKeyVault над моком safeStorage с быстрой калибровкой
// (§19, прецедент container-passphrase.int.test.ts); broadcast замокан (боевой
// синглтон тянет electron webContents — прецедент container-event-bridge.int.test).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock, unsafeUnwrap, type Clock } from '@hl/kernel';

import { broadcastToWindows } from './events/broadcast.js';
import { buildContainer, DATABASE_FILENAME, type Container } from './container.js';
import { VAULT_KEY_FILENAME } from './shared/constants.js';
import type { Argon2Params } from './modules/security/adapters/passphrase-crypto.js';
import {
  SafeStorageKeyVault,
  type VaultLogger,
  type VaultSafeStorage,
} from './modules/security/adapters/safe-storage-key-vault.js';

vi.mock('./events/broadcast.js', () => ({
  broadcastToWindows: vi.fn(),
}));

/** Пароль сценария и быстрые параметры калибровки (§19: миллисекунды). */
const PASS = 'пароль-контейнера-094';
const NEW_PASS = 'новый-пароль-контейнера-094';
const FAST_PARAMS: Argon2Params = { iterations: 1, memoryKib: 8192, parallelism: 1 };

/** База моментов сценария; TZ как в контрактных наборах. */
const BASE_MS = 1_758_816_000_000;
const TZ = 180;

/** Свежий tmp-userData (каталог БД и vault.key). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-vault-'));

/**
 * Детерминированные часы с ручным продвижением — ОБЩИЕ для контейнера и сценария
 * (автоблок AC4 без реальных таймеров, NFR-10).
 */
class MutableClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  tzOffsetMin(): number {
    return TZ;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

/** Мок safeStorage — симметричный «шифр» с префиксом (§19, прецедент TASK-023). */
class FakeSafeStorage implements VaultSafeStorage {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`hl-vault-test:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('hl-vault-test:')) {
      return 'расшифрованный-мусор-не-ключ';
    }
    return text.slice('hl-vault-test:'.length);
  }
}

const silentLogger: VaultLogger = { info: () => undefined, warn: () => undefined };

/** Готовит tmp-userData с vault-файлом mode=passphrase (пароль включён заранее). */
const setupPassphraseUserData = async (dir: string): Promise<void> => {
  const vault = new SafeStorageKeyVault({
    vaultFilePath: join(dir, VAULT_KEY_FILENAME),
    safeStorage: new FakeSafeStorage(),
    clock: new FixedClock(BASE_MS, TZ),
    logger: silentLogger,
    calibrate: () => Promise.resolve(FAST_PARAMS),
  });
  unsafeUnwrap(await vault.ensureKey(false));
  unsafeUnwrap(await vault.setPassphrase(PASS));
};

/** Валидная команда measurements/add (прецедент container-event-bridge.int.test). */
const addMeasurement = (utcMs: number) => ({
  profileId: 'seed-profile-0001',
  sys: 122,
  dia: 81,
  pulse: 62,
  irregularPulse: false,
  arm: 'left',
  takenAt: { utcMs, tzOffsetMin: TZ },
});

describe('buildContainer — локальный вход через каналы (TASK-094 §19/§20)', () => {
  const dirs: string[] = [];
  const containers: Container[] = [];

  beforeEach(() => {
    vi.mocked(broadcastToWindows).mockClear();
    const dir = newUserDataDir();
    dirs.push(dir);
  });

  afterAll(() => {
    for (const container of containers) {
      try {
        container.close();
      } catch {
        // закрыт самим сценарием (lock) — не важно для очистки
      }
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const track = (container: Container): Container => {
    containers.push(container);
    return container;
  };

  it('полный цикл: locked-старт → backoff → unlock → запись → lock (-wal исчез) → VAULT/LOCKED → unlock → данные на месте; события доставлены (AC3/AC6)', async () => {
    const dir = dirs[dirs.length - 1] as string;
    await setupPassphraseUserData(dir);
    const clock = new MutableClock(BASE_MS);
    const container = track(
      await buildContainer({ userDataPath: dir, clock, vault: makeVaultFactory() }),
    );
    const dispatch = (channel: string, payload: unknown) =>
      container.channels.dispatch({ channel, payload });

    // Старт заблокированным: статус и событие lock:required мосту (AC6, §12).
    expect(vi.mocked(broadcastToWindows).mock.calls.map((call) => call[0])).toContain(
      'lock:required',
    );
    expect(await dispatch('vault/status', {})).toEqual({
      v: 1,
      ok: true,
      data: { mode: 'passphrase', locked: true },
    });
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);

    // Гвардия: БД-канал при locked — чистый конверт VAULT/LOCKED (§7/§11).
    expect(await dispatch('measurements/list', { profileId: 'seed-profile-0001' })).toEqual({
      v: 1,
      ok: false,
      error: { code: 'VAULT/LOCKED', messageKey: 'errors.VAULT_LOCKED' },
    });

    // Три неверных пароля: 1-я/2-я — без backoff (§13), 3-я ставит окно 1 с.
    expect((await dispatch('vault/unlock', { pass: 'неверный-1' })).ok).toBe(false);
    expect((await dispatch('vault/unlock', { pass: 'неверный-2' })).ok).toBe(false);
    const third = await dispatch('vault/unlock', { pass: 'неверный-3' });
    expect(third.ok).toBe(false);
    expect(await dispatch('vault/status', {})).toMatchObject({
      ok: true,
      data: { mode: 'passphrase', locked: true, backoffSec: 1 },
    });

    // Четвёртая попытка в окне — отказ RATE_LIMITED с backoffSec (§5/§17).
    const refused = await dispatch('vault/unlock', { pass: PASS });
    expect(refused).toEqual({
      v: 1,
      ok: false,
      error: {
        code: 'VAULT/RATE_LIMITED',
        messageKey: 'errors.VAULT_RATE_LIMITED',
        params: { backoffSec: 1 },
      },
    });

    // Окно истекло — верный пароль открывает: БД создана, мигрирована, открыта (§9 093).
    clock.advance(1_000);
    expect(await dispatch('vault/unlock', { pass: PASS })).toEqual({
      v: 1,
      ok: true,
      data: { ok: true },
    });
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);

    // Запись через канал — -wal появляется (WAL-режим, §8).
    expect((await dispatch('measurements/add', addMeasurement(BASE_MS - 3_600_000))).ok).toBe(true);
    expect(existsSync(`${join(dir, DATABASE_FILENAME)}-wal`)).toBe(true);

    // Ручной lock: БД закрыта checkpoint'ом — -wal/-shm исчезли (AC3, тест ФС);
    // событие lock:engaged доставлено мосту (AC6).
    expect(await dispatch('vault/lock', {})).toEqual({ v: 1, ok: true, data: { locked: true } });
    expect(existsSync(`${join(dir, DATABASE_FILENAME)}-wal`)).toBe(false);
    expect(existsSync(`${join(dir, DATABASE_FILENAME)}-shm`)).toBe(false);
    expect(vi.mocked(broadcastToWindows).mock.calls.map((call) => call[0])).toContain(
      'lock:engaged',
    );

    // После lock БД-каналы снова LOCKED; prefs — тоже (app_setting в БД, §7).
    expect((await dispatch('measurements/list', { profileId: 'seed-profile-0001' })).ok).toBe(
      false,
    );
    const prefsWhileLocked = await dispatch('prefs/get', {});
    expect(prefsWhileLocked.ok).toBe(false);
    if (!prefsWhileLocked.ok) {
      expect(prefsWhileLocked.error).toMatchObject({ code: 'VAULT/LOCKED' });
    }

    // Повторный unlock открывает — данные на месте (§13, §8 «повторное открытие»).
    clock.advance(1_000);
    expect(await dispatch('vault/unlock', { pass: PASS })).toEqual({
      v: 1,
      ok: true,
      data: { ok: true },
    });
    const list = await dispatch('measurements/list', {
      profileId: 'seed-profile-0001',
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      const data = list.data as { items: unknown[] };
      expect(data.items).toHaveLength(1);
    }
  });

  it('set-passphrase через каналы (§19): смена пароля — переобёртка; старый больше не открывает', async () => {
    const dir = dirs[dirs.length - 1] as string;
    await setupPassphraseUserData(dir);
    const clock = new MutableClock(BASE_MS);
    const container = track(
      await buildContainer({ userDataPath: dir, clock, vault: makeVaultFactory() }),
    );
    const dispatch = (channel: string, payload: unknown) =>
      container.channels.dispatch({ channel, payload });

    expect(await dispatch('vault/unlock', { pass: PASS })).toEqual({
      v: 1,
      ok: true,
      data: { ok: true },
    });
    // Смена пароля через канал: ответ — текущий режим (переобёртка, §13 093).
    expect(
      await dispatch('vault/set-passphrase', { action: 'change', old: PASS, new: NEW_PASS }),
    ).toEqual({ v: 1, ok: true, data: { mode: 'passphrase' } });

    // lock → unlock старым — WRONG_PASSPHRASE (1-я неудача, без backoff); новым — ok.
    await dispatch('vault/lock', {});
    clock.advance(1_000);
    const oldResult = await dispatch('vault/unlock', { pass: PASS });
    expect(oldResult).toMatchObject({
      ok: false,
      error: { code: 'VAULT/WRONG_PASSPHRASE', messageKey: 'errors.VAULT_WRONG_PASSPHRASE' },
    });
    expect(await dispatch('vault/unlock', { pass: NEW_PASS })).toEqual({
      v: 1,
      ok: true,
      data: { ok: true },
    });

    // Новая сессия (перезапуск приложения): файл переобёрнут — новый пароль открывает.
    const session2 = track(
      await buildContainer({ userDataPath: dir, clock, vault: makeVaultFactory() }),
    );
    expect(
      await session2.channels.dispatch({ channel: 'vault/unlock', payload: { pass: NEW_PASS } }),
    ).toEqual({ v: 1, ok: true, data: { ok: true } });
  });

  it('автоблок 5 мин через контейнер (AC4): простой 5:00 → lock; активность на 4:59 продлевает', async () => {
    const dir = dirs[dirs.length - 1] as string;
    await setupPassphraseUserData(dir);
    const clock = new MutableClock(BASE_MS);
    const container = track(
      await buildContainer({ userDataPath: dir, clock, vault: makeVaultFactory() }),
    );
    const dispatch = (channel: string, payload: unknown) =>
      container.channels.dispatch({ channel, payload });

    // Разблокировка и настройка порога 5 мин (оба вызова — активность на BASE_MS).
    await dispatch('vault/unlock', { pass: PASS });
    expect((await dispatch('prefs/set', { patch: { autoLockMin: 5 } })).ok).toBe(true);
    expect((await dispatch('measurements/add', addMeasurement(BASE_MS - 60_000))).ok).toBe(true);
    expect(existsSync(`${join(dir, DATABASE_FILENAME)}-wal`)).toBe(true);

    // Активность на 4:59 (любой IPC-вызов, §9) продлевает окно.
    clock.advance(4 * 60_000 + 59_000);
    await dispatch('vault/status', {});
    clock.advance(4 * 60_000 + 59_000); // 4:59 простоя после неё
    await container.vaultService.checkAutolock();
    // Снимок состояния — через сервис: сам dispatch был бы активностью (§9).
    expect(container.vaultService.getStatus()).toMatchObject({ locked: false });

    // Ещё секунда простоя (5:00) — тик проверки блокирует: БД закрыта (§5/§9).
    clock.advance(1_000);
    await container.vaultService.checkAutolock();
    expect(container.vaultService.getStatus()).toMatchObject({ locked: true });
    expect(existsSync(`${join(dir, DATABASE_FILENAME)}-wal`)).toBe(false);
    expect(vi.mocked(broadcastToWindows).mock.calls.map((call) => call[0])).toContain(
      'lock:engaged',
    );
  });
});

/** Фабрика боевого vault-адаптера над моком safeStorage (§19; см. шапку). */
const makeVaultFactory =
  () => (context: { vaultFilePath: string; clock: Clock; logger: VaultLogger }) =>
    new SafeStorageKeyVault({
      vaultFilePath: context.vaultFilePath,
      safeStorage: new FakeSafeStorage(),
      clock: context.clock,
      logger: context.logger,
      calibrate: () => Promise.resolve(FAST_PARAMS),
    });
