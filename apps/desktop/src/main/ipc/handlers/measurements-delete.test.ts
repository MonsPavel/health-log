// TASK-032 §9/§11: юниты хендлера `measurements/delete` — маппинг Result use case'а →
// ответ канала: ok → {deleted: true} (проверка строгой схемой TASK-028 — контракт
// формы доказан парсом), err → AppError наружу (каркас TASK-008 конвертирует его в
// ApiFailure(toDto)); NOT_FOUND проходит как есть (§7/§13 — UI покажет «уже удалена»).
import { describe, expect, it, vi } from 'vitest';

import { MEASUREMENT_DELETE_RESPONSE_SCHEMA } from '@hl/contracts';
import { FixedClock, unsafeUnwrap } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../../modules/measurement/adapters/measurement-repo.fake.js';
import { DeleteMeasurementUseCase } from '../../modules/measurement/application/delete-measurement.js';
import { BpMeasurement } from '../../modules/measurement/domain/bp-measurement.js';
import { createDeleteMeasurementHandler } from './measurements-delete.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10, прецедент measurements. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;

const clock = new FixedClock(NOW_MS, TZ);

/** Реальный use case на подстановочных зависимостях (fake-repo, spy-события). */
const makeHandler = () => {
  const repo = new InMemoryBpMeasurementRepository();
  const events = { emit: vi.fn() };
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const useCase = new DeleteMeasurementUseCase({ repo, events, logger });
  return { handler: createDeleteMeasurementHandler(useCase), repo };
};

/** Запись для удаления: агрегат через фабрику домена (единственный путь, TASK-017). */
const record = (): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys: 125,
        dia: 82,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
      },
      clock,
    ),
  );

describe('createDeleteMeasurementHandler — Result → ответ канала (§9/§11)', () => {
  it('ok → {deleted: true}, форма валидна строгой схемой; запись удалена', async () => {
    const { handler, repo } = makeHandler();
    const m = record();
    await repo.add(m);

    const response = await handler({ id: m.id });

    // Строгая .strict()-схема канала принимает ответ — контракт §11 TASK-028 доказан.
    expect(MEASUREMENT_DELETE_RESPONSE_SCHEMA.parse(response)).toEqual(response);
    expect(response).toEqual({ deleted: true });
    expect(await repo.getById(m.id)).toBeUndefined();
  });

  it('err (NOT_FOUND) → AppError наружу с кодом MEASUREMENT/NOT_FOUND (каркас вернёт ApiFailure)', async () => {
    const { handler } = makeHandler();

    const promise = handler({ id: 'no-such-id' });

    await expect(promise).rejects.toMatchObject({ code: 'MEASUREMENT/NOT_FOUND' });
  });
});
