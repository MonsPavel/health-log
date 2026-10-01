// TASK-037 §5/§19: консолидационный интеграционный тест — все 4 канала журнала
// (add/list/update/delete) против ОДНОГО tmp-контейнера: полный жизненный цикл одной
// записи add → update → list → delete + 2 fixtures-мутации, data_version растёт на
// КАЖДОЙ мутации (точная арифметика утверждается на каждом шаге). Консолидация (§22):
// единое поведение CRUD — события (оба, в одном порядке), коды ошибок (NOT_FOUND
// сквозь каркас), форма ответов (строгие схемы TASK-028). Каркас TASK-008 прогоняется
// реальным container.channels.dispatch (§11); запись реально в шифрованной SQLite.
//
// АРИФМЕТИКА data_version (§20): старт 1; add → 2; update → 3; list не мутирует;
// delete → 4; +2 fixtures-мутации → 5, 6. Спека §20 суммирует те же операнды как
// «1→5» — при её же составе (add, update, delete, +2 fixtures) бампов ровно 5, финал
// от старта 1 — 6 (офсет на стартовое значение); тест фиксирует точное значение
// после каждого шага, что и требует «точная арифметика в тесте».
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  API_ENVELOPE_VERSION,
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  MEASUREMENT_DELETE_RESPONSE_SCHEMA,
  MEASUREMENT_LIST_RESPONSE_SCHEMA,
  MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
} from '@hl/contracts';
import { AppError, FixedClock, unsafeUnwrap, type Result, ok } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import { BpMeasurement } from '../../modules/measurement/domain/bp-measurement.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ мок-vault (§19) — 32 байта, прецедент measurements.int. */
const KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» FixedClock — как в контрактных наборах (2025-09-25T16:00:00Z). */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const MINUTE_MS = 60_000;

/** Свежий tmp-userData; удаление — в конце кейса (§14: ФС пользователя не затрагивается). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-measurement-crud-int-'));

/** Мок-vault (§19): фиксированный ключ без safeStorage — прецедент measurements.int. */
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

describe('measurements CRUD через контейнер — полный жизненный цикл (TASK-037 §19/§20)', () => {
  it('add → update → list → delete (+2 fixtures): версия растёт на каждой мутации, события едины', async () => {
    const dir = newUserDataDir();
    const container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });
    try {
      // v1 имеет FK bp_measurement.profile_id → profile(id): профиль — подготовка
      // окружения (прецедент measurements.int.test.ts, §19).
      container.db
        .prepare(
          "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0)",
        )
        .run();

      // Консолидация событий (§22): подписка на шину контейнера — add/update/delete
      // обязаны публиковать ОДИНАКОВЫЕ пары в ОДНОМ порядке.
      const changedProfileIds: string[] = [];
      const bumpedVersions: number[] = [];
      container.events.on('measurement:changed', (payload) => {
        changedProfileIds.push(payload.profileId);
      });
      container.events.on('data:versionBumped', (payload) => {
        bumpedVersions.push(payload.newVersion);
      });

      // Стартовая версия — 1 (§13 порта TASK-021).
      expect(await container.measurementRepo.currentDataVersion()).toBe(1);

      // ── 1. ADD (канал measurements/add) → data_version 2 ────────────────────────
      const addEnvelope = await container.channels.dispatch({
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
      expect(addEnvelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
      if (!addEnvelope.ok) {
        return;
      }
      const added = MEASUREMENT_ADD_RESPONSE_SCHEMA.parse(addEnvelope.data);
      expect(added.measurement).toMatchObject({ profileId: 'profile-1', sys: 125, dia: 82 });
      const id = added.measurement.id;
      expect(await container.measurementRepo.currentDataVersion()).toBe(2);

      // ── 2. UPDATE (канал measurements/update) → data_version 3 ──────────────────
      const updateEnvelope = await container.channels.dispatch({
        channel: 'measurements/update',
        payload: {
          id,
          sys: 130,
          dia: 84,
          pulse: 70,
          irregularPulse: false,
          arm: 'right',
          note: 'исправлено',
          takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
        },
      });
      expect(updateEnvelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
      if (!updateEnvelope.ok) {
        return;
      }
      // Форма ответа — контракт §66 TASK-028 ({measurement}) доказан парсом строгой
      // схемы: duplicate в ответе update отсутствует по построению (§5).
      const updated = MEASUREMENT_UPDATE_RESPONSE_SCHEMA.parse(updateEnvelope.data);
      expect(updated.measurement).toMatchObject({
        id,
        sys: 130,
        dia: 84,
        arm: 'right',
        note: 'исправлено',
        createdAtUtcMs: NOW_MS, // наследован от add
        updatedAtUtcMs: NOW_MS, // штамп правки — «сейчас» Clock'а
      });
      // Read-back: правка реально в SQLite, roundtrip равен (мапперы TASK-026).
      const stored = await container.measurementRepo.getById(id);
      expect(stored?.bp.sys).toBe(130);
      expect(stored?.bp.dia).toBe(84);
      expect(stored?.arm).toBe('right');
      expect(stored?.updatedAtUtc).toBe(NOW_MS);
      expect(await container.measurementRepo.currentDataVersion()).toBe(3);

      // ── 3. LIST (канал measurements/list) — чтение, версию не мутирует ─────────
      const listEnvelope = await container.channels.dispatch({
        channel: 'measurements/list',
        payload: { profileId: 'profile-1' },
      });
      expect(listEnvelope).toMatchObject({ ok: true });
      if (!listEnvelope.ok) {
        return;
      }
      const listed = MEASUREMENT_LIST_RESPONSE_SCHEMA.parse(listEnvelope.data);
      expect(listed.total).toBe(1);
      expect(listed.items[0]).toMatchObject({ id, sys: 130, dia: 84 });
      expect(await container.measurementRepo.currentDataVersion()).toBe(3);

      // ── 4. DELETE (канал measurements/delete) → data_version 4 ──────────────────
      const deleteEnvelope = await container.channels.dispatch({
        channel: 'measurements/delete',
        payload: { id },
      });
      expect(deleteEnvelope).toMatchObject({ ok: true });
      if (!deleteEnvelope.ok) {
        return;
      }
      expect(MEASUREMENT_DELETE_RESPONSE_SCHEMA.parse(deleteEnvelope.data)).toEqual({
        deleted: true,
      });
      expect(await container.measurementRepo.getById(id)).toBeUndefined();
      expect(await container.measurementRepo.currentDataVersion()).toBe(4);

      // ── 5. +2 fixtures-мутации (репозиторий) → data_version 5, 6 ────────────────
      const fixtureIds: string[] = [];
      for (const [index, minute] of [3, 4].entries()) {
        const fixture = unsafeUnwrap(
          BpMeasurement.create(
            {
              profileId: 'profile-1',
              sys: 120 + index,
              dia: 80,
              irregularPulse: false,
              arm: 'left',
              takenAt: { utcMs: NOW_MS - minute * MINUTE_MS, tzOffsetMin: TZ },
            },
            new FixedClock(NOW_MS, TZ),
          ),
        );
        expect((await container.measurementRepo.add(fixture)).ok).toBe(true);
        fixtureIds.push(fixture.id);
        expect(await container.measurementRepo.currentDataVersion()).toBe(5 + index);
      }

      // Журнал после удаления: фикстуры на месте, правимой записи нет.
      const finalListEnvelope = await container.channels.dispatch({
        channel: 'measurements/list',
        payload: { profileId: 'profile-1' },
      });
      expect(finalListEnvelope).toMatchObject({ ok: true });
      if (!finalListEnvelope.ok) {
        return;
      }
      const finalList = MEASUREMENT_LIST_RESPONSE_SCHEMA.parse(finalListEnvelope.data);
      expect(finalList.total).toBe(2);
      expect(finalList.items.some((item) => item.id === id)).toBe(false);

      // Консолидация событий (§22): одна пара на каждую мутацию (add/update/delete),
      // в одном порядке; list и отказы событий не публикуют.
      expect(changedProfileIds).toEqual(['profile-1', 'profile-1', 'profile-1']);
      expect(bumpedVersions).toEqual([2, 3, 4]);

      // Консолидация кодов (§22): отказы сквозь каркас — те же AppError-коды, что у
      // add/delete-путей; мутаций нет — версия не сдвинулась (6).
      const notFound = await container.channels.dispatch({
        channel: 'measurements/update',
        payload: {
          id: 'no-such-id',
          sys: 120,
          dia: 80,
          irregularPulse: false,
          arm: 'left',
          takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
        },
      });
      expect(notFound).toMatchObject({ ok: false });
      if (notFound.ok) {
        return;
      }
      expect(notFound.error.code).toBe('MEASUREMENT/NOT_FOUND');

      const futureTime = await container.channels.dispatch({
        channel: 'measurements/update',
        payload: {
          id: fixtureIds[0] ?? '',
          sys: 120,
          dia: 80,
          irregularPulse: false,
          arm: 'left',
          takenAt: { utcMs: NOW_MS + MINUTE_MS, tzOffsetMin: TZ },
        },
      });
      expect(futureTime).toMatchObject({ ok: false });
      if (futureTime.ok) {
        return;
      }
      expect(futureTime.error.code).toBe('MEASUREMENT/FUTURE_TIME');
      expect(await container.measurementRepo.currentDataVersion()).toBe(6);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
