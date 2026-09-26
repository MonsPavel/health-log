// TASK-032 §19: юниты use case deleteMeasurement на fake-repo (TASK-021) и spy-событиях.
// Матрица §19: delete ок (запись удалена из repo, оба события «как в add» — §9,
// результат {deleted: true} — §7); NOT_FOUND-ветка (§7/§13: err MEASUREMENT/NOT_FOUND,
// событий нет — UI покажет тост «уже удалена», не краш); STORAGE/* → err + лог, событий
// нет. Дополнительно: событие measurement:changed несёт profileId удалённой записи,
// data:versionBumped — актуальную версию порта.
import { describe, expect, it, vi } from 'vitest';

import { AppError, FixedClock, unsafeUnwrap } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../adapters/measurement-repo.fake.js';
import { BpMeasurement } from '../domain/bp-measurement.js';
import { DeleteMeasurementUseCase } from './delete-measurement.js';
import type { BpMeasurementRepository } from './ports/bp-measurement-repository.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10, прецедент add-теста. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;

const clock = new FixedClock(NOW_MS, TZ);

/** Подставочные зависимости: события и логгер — vi.fn-шпионы (§19, прецедент add). */
const makeEvents = () => ({
  emit: vi.fn<(name: string, payload: unknown) => void>(() => {}),
});
const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

/** Запись для удаления: агрегат через фабрику домена (единственный путь, TASK-017). */
const record = (): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys: 125,
        dia: 82,
        pulse: 70,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
      },
      clock,
    ),
  );

/** Use case с шпионами; repo можно передать для спая над его методами. */
const makeUseCase = (
  repo: BpMeasurementRepository = new InMemoryBpMeasurementRepository(),
): {
  useCase: DeleteMeasurementUseCase;
  events: ReturnType<typeof makeEvents>;
  logger: ReturnType<typeof makeLogger>;
} => {
  const events = makeEvents();
  const logger = makeLogger();
  return {
    useCase: new DeleteMeasurementUseCase({ repo, events, logger }),
    events,
    logger,
  };
};

describe('DeleteMeasurementUseCase — happy path (§19/§9)', () => {
  it('ok: запись удалена из repo, оба события «как в add» по порядку, результат {deleted: true}', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const m = record();
    await repo.add(m);
    const { useCase, events, logger } = makeUseCase(repo);

    const result = await useCase.execute({ id: m.id });

    // §7: DeleteResult = {deleted: true}.
    expect(result).toEqual({ ok: true, value: { deleted: true } });
    // Запись реально удалена из fake-repo (§19).
    expect(await repo.getById(m.id)).toBeUndefined();
    // События (§9 — «как в add»): оба, по порядку арх. 05 §5.
    expect(events.emit.mock.calls.map((call) => call[0])).toEqual([
      'measurement:changed',
      'data:versionBumped',
    ]);
    // measurement:changed несёт профиль удалённой записи (payload-контракт events).
    expect(events.emit).toHaveBeenCalledWith('measurement:changed', { profileId: 'profile-1' });
    // data_version: 1 (старт) → 2 (add) → 3 (delete); событие несёт актуальную версию.
    expect(events.emit).toHaveBeenCalledWith('data:versionBumped', { newVersion: 3 });
    // Лог (стиль §18 add): длительность, без значений измерений (PHI, TASK-010).
    expect(logger.info).toHaveBeenCalledWith(
      'deleteMeasurement',
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
    const infoMeta = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(infoMeta).not.toHaveProperty('sys');
    expect(infoMeta).not.toHaveProperty('note');
  });
});

describe('DeleteMeasurementUseCase — NOT_FOUND-ветка (§7/§13)', () => {
  it('несуществующий id: err MEASUREMENT/NOT_FOUND, событий нет (UI покажет «уже удалена», не краш)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const deleteSpy = vi.spyOn(repo, 'delete');
    const { useCase, events } = makeUseCase(repo);

    const result = await useCase.execute({ id: 'no-such-id' });

    expect(result).toMatchObject({ ok: false, error: { code: 'MEASUREMENT/NOT_FOUND' } });
    expect(events.emit).not.toHaveBeenCalled();
    // Ключ сообщения — тот же, что у порта (errors.MEASUREMENT_NOT_FOUND): тост тостом,
    // не крашем (§7).
    expect(result).toMatchObject({
      error: { messageKey: 'errors.MEASUREMENT_NOT_FOUND' },
    });
    // Записи нет — delete порта не нужен: исход тот же NOT_FOUND (короткий путь).
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('повторный delete той же записи: второй вызов → NOT_FOUND, первая запись осталась удалённой', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const m = record();
    await repo.add(m);
    const { useCase } = makeUseCase(repo);

    expect(await useCase.execute({ id: m.id })).toEqual({ ok: true, value: { deleted: true } });
    expect(await useCase.execute({ id: m.id })).toMatchObject({
      ok: false,
      error: { code: 'MEASUREMENT/NOT_FOUND' },
    });
    expect((await repo.listByPeriod({ profileId: 'profile-1' })).length).toBe(0);
  });
});

describe('DeleteMeasurementUseCase — отказ хранения (§9)', () => {
  it('STORAGE/* от repo.delete → err, событий нет, отказ в логе', async () => {
    const m = record();
    const storageError = AppError.of('STORAGE/FAILED', 'errors.STORAGE_FAILED');
    const base = new InMemoryBpMeasurementRepository();
    await base.add(m);
    // Стаб порта: getById читает fake, delete — отказ STORAGE/FAILED (прецедент
    // add-теста: spread класса методы прототипа не копирует — стаб собирается явно).
    const failingRepo: BpMeasurementRepository = {
      add: (x) => base.add(x),
      update: (x) => base.update(x),
      delete: () => Promise.resolve({ ok: false, error: storageError }),
      getById: (id) => base.getById(id),
      listByPeriod: (q) => base.listByPeriod(q),
      countByPeriod: (q) => base.countByPeriod(q),
      currentDataVersion: () => base.currentDataVersion(),
    };
    const { useCase, events, logger } = makeUseCase(failingRepo);

    const result = await useCase.execute({ id: m.id });

    expect(result).toMatchObject({ ok: false, error: { code: 'STORAGE/FAILED' } });
    expect(events.emit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
