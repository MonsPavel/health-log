// TASK-029 §9/§11: юниты хендлера `measurements/add` — маппинг Result use case'а →
// ответ канала: ok → MeasurementAddResponse (проверка строгой схемой TASK-028 —
// контракт формы доказан парсом), err → AppError наружу (каркас TASK-008 конвертирует
// его в ApiFailure(toDto)); домен-ошибка проходит как есть (FUTURE_TIME).
import { describe, expect, it, vi } from 'vitest';

import { MEASUREMENT_ADD_RESPONSE_SCHEMA, type MeasurementAddRequest } from '@hl/contracts';
import { FixedClock } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../../modules/measurement/adapters/measurement-repo.fake.js';
import { AddMeasurementUseCase } from '../../modules/measurement/application/add-measurement.js';
import { createAddMeasurementHandler } from './measurements.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;

const clock = new FixedClock(NOW_MS, TZ);

/** Валидный payload канала (форма zod-схемы TASK-028). */
const payload: MeasurementAddRequest = {
  profileId: 'profile-1',
  sys: 120,
  dia: 80,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
};

/** Реальный use case на подстановочных зависимостях (fake-repo, spy-события). */
const makeHandler = () => {
  const repo = new InMemoryBpMeasurementRepository();
  const events = { emit: vi.fn() };
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const useCase = new AddMeasurementUseCase({ repo, clock, events, logger });
  return { handler: createAddMeasurementHandler(useCase), repo, events };
};

describe('createAddMeasurementHandler — Result → ответ канала (§9)', () => {
  it('ok → MeasurementAddResponse, форма валидна строгой схемой; флаги пустые опущены', async () => {
    const { handler } = makeHandler();

    const response = await handler(payload);

    // Строгая .strict()-схема канала принимает ответ — контракт §11 доказан.
    expect(MEASUREMENT_ADD_RESPONSE_SCHEMA.parse(response)).toEqual(response);
    expect(response.measurement).toMatchObject({ profileId: 'profile-1', sys: 120, dia: 80 });
    expect(response.flags).toEqual({ duplicate: false });
  });

  it('критические значения отражаются в флагах ответа (200/130 → criticalValue=high)', async () => {
    const { handler } = makeHandler();

    const response = await handler({ ...payload, sys: 200, dia: 130 });

    expect(MEASUREMENT_ADD_RESPONSE_SCHEMA.parse(response)).toEqual(response);
    expect(response.flags.criticalValue).toBe('high');
  });

  it('err (будущее время) → AppError наружу с кодом; записи нет (каркас вернёт ApiFailure)', async () => {
    const { handler, repo } = makeHandler();

    const promise = handler({
      ...payload,
      takenAt: { utcMs: NOW_MS + MINUTE_MS, tzOffsetMin: TZ },
    });

    await expect(promise).rejects.toMatchObject({ code: 'MEASUREMENT/FUTURE_TIME' });
    expect((await repo.listByPeriod({ profileId: 'profile-1' })).length).toBe(0);
  });
});
