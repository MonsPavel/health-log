// TASK-029 §19/§20: интеграционный тест — полный путь «UI → use case → шифрованная
// БД» через контейнер (TASK-027) на tmp-userData с FixedClock и мок-vault (§19:
// без safeStorage — прецедент container.int.test.ts). Реальный вызов хендлера —
// через зарегистрированный каркас container.channels.dispatch (§11); запись реально
// в SQLite, read-back равен (мапперы roundtrip, TASK-026).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { API_ENVELOPE_VERSION, MEASUREMENT_ADD_RESPONSE_SCHEMA } from '@hl/contracts';
import { AppError, FixedClock, type Result } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ мок-vault (§19) — 32 байта. */
const KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» FixedClock — как в контрактных наборах (2025-09-25T16:00:00Z). */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const MINUTE_MS = 60_000;

/** Свежий tmp-userData; удаление — в конце кейса (§14: ФС пользователя не затрагивается). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-measurements-int-'));

/** Мок-vault (§19): фиксированный ключ без safeStorage — прецедент container.int.test.ts. */
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
}

describe('measurements/add через контейнер — полный путь (§20)', () => {
  it('dispatch → конверт ok с флагами; запись реально в SQLite (read-back равен); повтор — дубль', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });
    try {
      // v1 имеет FK bp_measurement.profile_id → profile(id): профиль — подготовка
      // окружения (прецедент container.int.test.ts, §19).
      container.db
        .prepare(
          "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0)",
        )
        .run();

      const envelope = await container.channels.dispatch({
        channel: 'measurements/add',
        payload: {
          profileId: 'profile-1',
          sys: 125,
          dia: 82,
          pulse: 66,
          irregularPulse: false,
          arm: 'left',
          note: 'утром',
          takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
        },
      });

      expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
      if (!envelope.ok) {
        return;
      }
      // Форма ответа — контракт TASK-028 доказан парсом строгой схемы.
      const parsed = MEASUREMENT_ADD_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.flags).toEqual({ duplicate: false });
      expect(parsed.measurement).toMatchObject({ profileId: 'profile-1', sys: 125, dia: 82 });

      // Read-back: запись реально в SQLite (расшифрована тем же ключом), roundtrip равен.
      const stored = await container.measurementRepo.getById(parsed.measurement.id);
      expect(stored).toBeDefined();
      expect(stored?.profileId).toBe('profile-1');
      expect(stored?.bp.sys).toBe(125);
      expect(stored?.bp.dia).toBe(82);
      expect(stored?.pulse).toBe(66);
      expect(stored?.irregularPulse).toBe(false);
      expect(stored?.arm).toBe('left');
      expect(stored?.note).toBe('утром');
      expect(stored?.takenAt).toEqual({ utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ });
      expect(stored?.source).toBe('manual');
      // data_version: 1 (сид v1) → 2 (бамп мутации, §13 TASK-026/021).
      expect(await container.measurementRepo.currentDataVersion()).toBe(2);

      // §13: повторное сохранение тех же значений рядом по времени — оба сохраняются,
      // детектор срабатывает на втором (окно 2 мин); флаги информационные.
      const repeat = await container.channels.dispatch({
        channel: 'measurements/add',
        payload: {
          profileId: 'profile-1',
          sys: 125,
          dia: 82,
          irregularPulse: false,
          arm: 'right',
          takenAt: { utcMs: NOW_MS, tzOffsetMin: TZ },
        },
      });
      expect(repeat).toMatchObject({ ok: true });
      if (!repeat.ok) {
        return;
      }
      expect(MEASUREMENT_ADD_RESPONSE_SCHEMA.parse(repeat.data).flags.duplicate).toBe(true);
      expect(await container.measurementRepo.currentDataVersion()).toBe(3);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('measurements/add через контейнер — отказы сквозь каркас (§9)', () => {
  it('sys вне диапазона → VALIDATION/FAILED (zod каркаса), записей нет', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });
    try {
      const envelope = await container.channels.dispatch({
        channel: 'measurements/add',
        payload: { profileId: 'profile-1', sys: 10, dia: 5, irregularPulse: false, arm: 'left' },
      });

      expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: false });
      if (envelope.ok) {
        return;
      }
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
      expect(await container.measurementRepo.listByPeriod({ profileId: 'profile-1' })).toEqual([]);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('будущее время (домен) → MEASUREMENT/FUTURE_TIME, БД не тронута', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });
    try {
      const envelope = await container.channels.dispatch({
        channel: 'measurements/add',
        payload: {
          profileId: 'profile-1',
          sys: 120,
          dia: 80,
          irregularPulse: false,
          arm: 'left',
          takenAt: { utcMs: NOW_MS + MINUTE_MS, tzOffsetMin: TZ },
        },
      });

      expect(envelope).toMatchObject({ ok: false });
      if (envelope.ok) {
        return;
      }
      expect(envelope.error.code).toBe('MEASUREMENT/FUTURE_TIME');
      expect(await container.measurementRepo.listByPeriod({ profileId: 'profile-1' })).toEqual([]);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
