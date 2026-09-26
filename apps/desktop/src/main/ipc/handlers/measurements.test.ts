// TASK-029 §9/§11: юниты хендлера `measurements/add` — маппинг Result use case'а →
// ответ канала: ok → MeasurementAddResponse (проверка строгой схемой TASK-028 —
// контракт формы доказан парсом), err → AppError наружу (каркас TASK-008 конвертирует
// его в ApiFailure(toDto)); домен-ошибка проходит как есть (FUTURE_TIME).
// TASK-030: юниты хендлера `measurements/list` — чтение через ListMeasurementsUseCase:
// ответ {items, total} по строгой схеме, пустой период → {items: [], total: 0},
// clamp limit 9999 → отдало ≤500 (§20 п. 3 — путь «запрос → use case → ответ»).
import { describe, expect, it, vi } from 'vitest';

import {
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  MEASUREMENT_LIST_RESPONSE_SCHEMA,
  type MeasurementAddRequest,
} from '@hl/contracts';
import { FixedClock, unsafeUnwrap } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../../modules/measurement/adapters/measurement-repo.fake.js';
import { AddMeasurementUseCase } from '../../modules/measurement/application/add-measurement.js';
import { ListMeasurementsUseCase } from '../../modules/measurement/application/list-measurements.js';
import { BpMeasurement } from '../../modules/measurement/domain/bp-measurement.js';
import { createAddMeasurementHandler, createListMeasurementHandler } from './measurements.js';

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

/** Запись для list-тестов: агрегат через фабрику домена (единственный путь, TASK-017). */
const listRecord = (
  utcMs: number,
  overrides: Partial<Parameters<typeof BpMeasurement.create>[0]> = {},
): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys: 120,
        dia: 80,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs, tzOffsetMin: TZ },
        ...overrides,
      },
      clock,
    ),
  );

/** Хендлер list на реальном use case с fake-repo (§19 TASK-030). */
const makeListHandler = () => {
  const repo = new InMemoryBpMeasurementRepository();
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const useCase = new ListMeasurementsUseCase({ repo, logger });
  return { handler: createListMeasurementHandler(useCase), repo };
};

describe('createListMeasurementHandler — чтение журнала (TASK-030 §9/§11)', () => {
  it('ok → MeasurementListResponse, форма валидна строгой схемой; items — плоские DTO', async () => {
    const { handler, repo } = makeListHandler();
    await repo.add(listRecord(NOW_MS - MINUTE_MS, { sys: 125, dia: 82, pulse: 66, note: 'утром' }));

    const response = await handler({ profileId: 'profile-1' });

    // Строгая .strict()-схема канала принимает ответ — контракт §11 TASK-028 доказан.
    expect(MEASUREMENT_LIST_RESPONSE_SCHEMA.parse(response)).toEqual(response);
    expect(response.items).toHaveLength(1);
    expect(response.total).toBe(1);
    expect(response.items[0]).toMatchObject({ profileId: 'profile-1', sys: 125, dia: 82 });
  });

  it('пустой период → {items: [], total: 0} — не ошибка (§20 п. 2)', async () => {
    const { handler } = makeListHandler();

    const response = await handler({ profileId: 'profile-1' });

    expect(response).toEqual({ items: [], total: 0 });
  });

  it('limit 9999 проходит валидацию схемы и use case отдаёт ≤500 (§20 п. 3 — путь хендлера)', async () => {
    const { handler, repo } = makeListHandler();
    for (let i = 0; i < 505; i += 1) {
      await repo.add(listRecord(NOW_MS - (61 + i) * MINUTE_MS));
    }

    const response = await handler({ profileId: 'profile-1', limit: 9999 });

    expect(MEASUREMENT_LIST_RESPONSE_SCHEMA.parse(response)).toEqual(response);
    expect(response.items.length).toBeLessThanOrEqual(500);
    expect(response.items.length).toBe(500);
    expect(response.total).toBe(505);
  });
});
