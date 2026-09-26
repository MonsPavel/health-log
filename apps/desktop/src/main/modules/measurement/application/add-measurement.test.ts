// TASK-029 §19: юниты use case addMeasurement на fake-repo (TASK-021), FixedClock
// (NFR-10) и spy-событиях. Матрица §20: happy-path (Result ok, запись в fake-repo,
// оба события, флаги пустые); будущее время → err FUTURE_TIME, add не вызван, событий
// нет; typo-флаг (история 128/82, кандидат 169/82 — отклонение 41 > 40); duplicate;
// 200/130 → criticalValue='high'. Дополнительно §9/§13: STORAGE/* → err + лог, событий
// нет; флаги информационные — запись сохраняется и события уходят и при флагах;
// duplicate+typo одновременно — оба флага; окно typo отсчитывается ОТ МОМЕНТА
// КАНДИДАТА (TASK-018 §46), окно дубля двустороннее (TASK-019 §7).
import { describe, expect, it, vi } from 'vitest';

import { AppError, FixedClock, unsafeUnwrap } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../adapters/measurement-repo.fake.js';
import { BpMeasurement } from '../domain/bp-measurement.js';
import { DUPLICATE_WINDOW_MS } from '../domain/constants.js';
import type { CreateMeasurementCommand } from '../domain/measurement-commands.js';
import { AddMeasurementUseCase } from './add-measurement.js';
import type { BpMeasurementRepository } from './ports/bp-measurement-repository.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10, прецедент доменных тестов. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const clock = new FixedClock(NOW_MS, TZ);

/** Подставочные зависимости: события и логгер — vi.fn-шпионы (§19: «spy events»). */
const makeEvents = () => ({
  // Типизация generic'ом vi.fn (прецедент broadcast.test.ts): mock.calls =
  // [string, unknown][] — без any в map-обходах.
  emit: vi.fn<(name: string, payload: unknown) => void>(() => {}),
});
const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

/** Команда по умолчанию: валидная, минуту назад от «сейчас» Clock'а. */
const command = (overrides: Partial<CreateMeasurementCommand> = {}): CreateMeasurementCommand => ({
  profileId: 'profile-1',
  sys: 120,
  dia: 80,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
  ...overrides,
});

/** Запись истории: агрегат через фабрику домена (единственный путь создания, TASK-017). */
const record = (sys: number, dia: number, utcMs: number): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys,
        dia,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs, tzOffsetMin: TZ },
      },
      clock,
    ),
  );

/** Use case с шпионами; repo можно передать для спая над его методами. */
const makeUseCase = (
  repo: BpMeasurementRepository = new InMemoryBpMeasurementRepository(),
  events = makeEvents(),
  logger = makeLogger(),
): {
  useCase: AddMeasurementUseCase;
  events: ReturnType<typeof makeEvents>;
  logger: ReturnType<typeof makeLogger>;
} => ({
  useCase: new AddMeasurementUseCase({ repo, clock, events, logger }),
  events,
  logger,
});

describe('AddMeasurementUseCase — happy path (§20)', () => {
  it('ok: запись в fake-repo, оба события по порядку, флаги пустые', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase, events, logger } = makeUseCase(repo);

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Ответ: DTO плоской формы агрегата (§7) с данными команды.
    expect(result.value.measurement).toMatchObject({
      profileId: 'profile-1',
      sys: 120,
      dia: 80,
      pulse: 70,
      arm: 'left',
      source: 'manual',
      takenAtUtcMs: NOW_MS - MINUTE_MS,
      tzOffsetMin: TZ,
      createdAtUtcMs: NOW_MS,
      updatedAtUtcMs: NOW_MS,
    });
    // Флаги пустые: typo нет, дубля нет, критичности нет (§7).
    expect(result.value.flags).toEqual({ duplicate: false });
    // Запись реально в fake-repo (§20 п. 1).
    const stored = await repo.getById(result.value.measurement.id);
    expect(stored).toBeDefined();
    expect(stored?.bp.sys).toBe(120);
    // События: оба, при успехе всегда (§11); порядок — как в последовательности арх. 05 §5.
    expect(events.emit.mock.calls.map((call) => call[0])).toEqual([
      'measurement:changed',
      'data:versionBumped',
    ]);
    expect(events.emit).toHaveBeenCalledWith('measurement:changed', { profileId: 'profile-1' });
    // data_version: 1 (старт) → 2 после первой записи (§13 TASK-021).
    expect(events.emit).toHaveBeenCalledWith('data:versionBumped', { newVersion: 2 });
    // Лог §18: addMeasurement durationMs flags=[] — БЕЗ значений измерений (PHI).
    expect(logger.info).toHaveBeenCalledWith(
      'addMeasurement',
      expect.objectContaining({ flags: [] }),
    );
    const infoMeta = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(infoMeta).not.toHaveProperty('sys');
    expect(infoMeta).not.toHaveProperty('note');
  });
});

describe('AddMeasurementUseCase — домен-ошибка: БД и события не трогаются (§9/§20)', () => {
  it('будущее время: err MEASUREMENT/FUTURE_TIME, add/listByPeriod не вызывались, событий нет', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const addSpy = vi.spyOn(repo, 'add');
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const { useCase, events } = makeUseCase(repo);

    const result = await useCase.execute(
      command({ takenAt: { utcMs: NOW_MS + MINUTE_MS, tzOffsetMin: TZ } }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'MEASUREMENT/FUTURE_TIME' } });
    expect(addSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('невалидный диапазон: err MEASUREMENT/INVALID_RANGE, событий нет', async () => {
    const { useCase, events } = makeUseCase();
    const result = await useCase.execute(command({ sys: 10 }));
    expect(result).toMatchObject({ ok: false, error: { code: 'MEASUREMENT/INVALID_RANGE' } });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('AddMeasurementUseCase — окно истории TypoHeuristic (§5/§19)', () => {
  it('запросы: 14 дней ОТ takenAt КАНДИДАТА, лимит 100; recent — окно дубля ±2 мин, лимит 10', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - 10 * DAY_MS; // кандидат задним числом (US-3)

    await useCase.execute(command({ takenAt: { utcMs: T0, tzOffsetMin: TZ } }));

    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profileId: 'profile-1',
        fromUtcMs: T0 - 14 * DAY_MS,
        toUtcMs: T0,
        limit: 100,
      }),
    );
    expect(listSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        profileId: 'profile-1',
        fromUtcMs: T0 - DUPLICATE_WINDOW_MS,
        toUtcMs: T0 + DUPLICATE_WINDOW_MS,
        limit: 10,
      }),
    );
  });

  it('typo-флаг: история 128/82 в окне кандидата, кандидат 169/82 → {field:sys, median:128, value:169, deviation:41}; окно от кандидата, а не от часов (§20)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase, events } = makeUseCase(repo);
    const T0 = NOW_MS - 10 * DAY_MS;
    // В окне кандидата: две записи 128/82 → медиана sys = 128.
    await repo.add(record(128, 82, T0 - 1 * DAY_MS));
    await repo.add(record(128, 82, T0 - 2 * DAY_MS));
    // Вне окна кандидата (но внутри окна «от часов»): три записи 200/130 — если окно
    // посчитано от clock.now, медиана станет 200 и отклонение 31 < 40, флаг исчезнет.
    await repo.add(record(200, 130, T0 + 1 * DAY_MS));
    await repo.add(record(200, 130, T0 + 2 * DAY_MS));
    await repo.add(record(200, 130, T0 + 3 * DAY_MS));

    const result = await useCase.execute(
      command({ sys: 169, dia: 82, takenAt: { utcMs: T0, tzOffsetMin: TZ } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Ровно 40 не срабатывает (TASK-018 §94), 41 — срабатывает.
    expect(result.value.flags.typo).toEqual({
      field: 'sys',
      median: 128,
      value: 169,
      deviation: 41,
    });
    // Флаг информационный: запись сохранена (§13), события ушли (§11).
    expect((await repo.listByPeriod({ profileId: 'profile-1' })).length).toBe(6);
    expect(events.emit.mock.calls.map((call) => call[0])).toEqual([
      'measurement:changed',
      'data:versionBumped',
    ]);
  });
});

describe('AddMeasurementUseCase — duplicate-флаг (§19/§20)', () => {
  it('те же sys/dia за минуту ДО кандидата → flags.duplicate=true', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - MINUTE_MS;
    await repo.add(record(120, 80, T0 - MINUTE_MS));

    const result = await useCase.execute(command({ takenAt: { utcMs: T0, tzOffsetMin: TZ } }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.duplicate).toBe(true);
    expect(result.value.flags.typo).toBeUndefined();
  });

  it('окно дубля двустороннее: запись ПОЗЖЕ кандидата (задним числом рядом со свежей) → duplicate=true', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - 5 * MINUTE_MS;
    await repo.add(record(120, 80, T0 + MINUTE_MS)); // минута после кандидата, до «сейчас»

    const result = await useCase.execute(command({ takenAt: { utcMs: T0, tzOffsetMin: TZ } }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.duplicate).toBe(true);
  });

  it('те же sys/dia за 3 минуты до кандидата (вне окна) → duplicate=false', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - MINUTE_MS;
    await repo.add(record(120, 80, T0 - 3 * MINUTE_MS));

    const result = await useCase.execute(command({ takenAt: { utcMs: T0, tzOffsetMin: TZ } }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.duplicate).toBe(false);
  });
});

describe('AddMeasurementUseCase — критические значения (§20)', () => {
  it('200/130 → criticalValue=high (границы включительно, TASK-020)', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.execute(command({ sys: 200, dia: 130 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.criticalValue).toBe('high');
  });

  it('85/55 → criticalValue=low', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.execute(command({ sys: 85, dia: 55 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.criticalValue).toBe('low');
  });

  it('120/80 → criticalValue отсутствует (между порогами)', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.execute(command({ sys: 120, dia: 80 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.criticalValue).toBeUndefined();
  });
});

describe('AddMeasurementUseCase — комбинация флагов и отказ хранения (§13/§9)', () => {
  it('duplicate + typo + critical одновременно: все три флага в ответе, newVersion отражает репозиторий', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase, events } = makeUseCase(repo);
    const T0 = NOW_MS - MINUTE_MS;
    await repo.add(record(200, 130, T0 - MINUTE_MS)); // дубль-кандидат
    await repo.add(record(128, 82, T0 - 1 * DAY_MS)); // медиана sys = 128
    await repo.add(record(128, 82, T0 - 2 * DAY_MS));

    const result = await useCase.execute(
      command({ sys: 200, dia: 130, takenAt: { utcMs: T0, tzOffsetMin: TZ } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.typo).toEqual({
      field: 'sys',
      median: 128,
      value: 200,
      deviation: 72,
    });
    expect(result.value.flags.duplicate).toBe(true);
    expect(result.value.flags.criticalValue).toBe('high');
    // data_version: 1 + 3 seed-записи + 1 кандидата = 5 (событие несёт актуальную версию).
    expect(events.emit).toHaveBeenCalledWith('data:versionBumped', { newVersion: 5 });
  });

  it('STORAGE/*: add упал → err, событий нет, в логе есть отказ (§9)', async () => {
    const storageError = AppError.of('STORAGE/FAILED', 'errors.STORAGE_FAILED');
    const base = new InMemoryBpMeasurementRepository();
    // Стаб порта: методы — делегирование в fake, add — отказ STORAGE/FAILED
    // (spread класса методы прототипа не копирует — стаб собирается явно).
    const failingRepo: BpMeasurementRepository = {
      add: () => Promise.resolve({ ok: false, error: storageError }),
      update: (m) => base.update(m),
      delete: (id) => base.delete(id),
      getById: (id) => base.getById(id),
      listByPeriod: (q) => base.listByPeriod(q),
      countByPeriod: (q) => base.countByPeriod(q), // TASK-030: метод порта; add его не использует
      currentDataVersion: () => base.currentDataVersion(),
    };
    const { useCase, events, logger } = makeUseCase(failingRepo);

    const result = await useCase.execute(command());

    expect(result).toMatchObject({ ok: false, error: { code: 'STORAGE/FAILED' } });
    expect(events.emit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
