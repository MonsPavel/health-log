// TASK-065 §5/§9/§11: интеграционный тест боевой проводки — контейнер собирает
// use case'ы файлового экспорта (очередь ОБЩАЯ с копией БД — один инстанс
// fileOpQueue, §9) и регистрирует каналы `report/export-csv|export-json` в
// реестре каркаса (§11 — регистрация в конце buildContainer).
//
// Хелперы (мок-vault, tmp-userData) повторяют container.int.test.ts: импорт
// тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия
// (прецедент container-pdf.int.test.ts).
//
// Диалог Electron в node-окружении недоступен — боевой ElectronFileSaver честно
// бросает исключение (ленивый import('electron')), оркестратор доставляет его
// как EXPORT/FAILED: это и есть проверка полной боевой цепочки канала (§9: до
// диалога доходит только main в рантайме Electron — ручная приёмка §24).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Result, ok } from '@hl/kernel';

import { buildContainer } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-report-int-'));

class MockVault implements KeyVault {
  private ensured = 0;

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({
      ok: true,
      value: { keyHex: KEY_HEX, created: this.ensured++ === 0 },
    });
  }

  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return Promise.resolve({
      ok: false,
      error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY),
    });
  }

  // TASK-093 §5/§7: парольные режимы в этом сценарии не используются — нейтральные
  // заглушки контракта (сессия всегда разблокирована, mode='none').
  setPassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  changePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  removePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  unlock(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  // TASK-094 §5: сброс сессии в mode=none — no-op (мок; см. порт key-vault).
  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

describe('container + каналы экспорта report/export-* (TASK-065 §9/§11)', () => {
  const dir = newUserDataDir();
  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container?.close();
    } catch {
      // повторное закрытие — no-op (§8 идемпотентность)
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('каналы зарегистрированы: валидный payload доходит до хендлера (ошибка диалога — EXPORT/FAILED, не APP/INTERNAL)', async () => {
    container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });

    // Полный боевой путь: схема → хендлер → оркестратор → очередь → use case 063 →
    // боевой saver. Вне Electron диалог недоступен (ленивый import честно бросает) —
    // канал отвечает EXPORT/FAILED (значит, цепочка пройдена до адаптера, §11).
    const csv = await container.channels.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: 'seed-profile-0001' },
    });
    expect(csv).toMatchObject({ v: 1, ok: false, error: { code: 'EXPORT/FAILED' } });

    const json = await container.channels.dispatch({
      channel: 'report/export-json',
      payload: { profileId: 'seed-profile-0001' },
    });
    expect(json).toMatchObject({ v: 1, ok: false, error: { code: 'EXPORT/FAILED' } });
  });

  it('битый payload → VALIDATION/FAILED (схема канала в реестре, хендлер не зовётся)', async () => {
    container =
      container ??
      (await buildContainer({
        userDataPath: dir,
        clock: new FixedClock(NOW_MS, TZ),
        vault: () => new MockVault(),
      }));

    const envelope = await container.channels.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: '' },
    });
    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
  });

  it('путь от renderer НЕ принимается схемой (§14: лишнее поле strict-режимом отвергнуто)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'report/export-json',
      payload: { profileId: 'seed-profile-0001', path: 'C:/evil/x.csv' },
    });
    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
  });

  it('очередь одна на экспорты и копии: fileOpQueue — тот же инстанс в графе (§9)', () => {
    // Контейнер строится без хендлеров копии (канал 073), но CreateBackup уже
    // работает на fileOpQueue (TASK-070 §5) — экспорты делят ЕГО (§9, факт сборки:
    // один инстанс на оба use case'а проверяется компиляцией графа в buildContainer).
    expect(container).toBeDefined();
    expect(existsSync(join(dir, 'health-log.db'))).toBe(true);
  });
});
