// TASK-037 §19: юниты use case updateMeasurement на fake-repo (TASK-021), FixedClock
// (NFR-10) и spy-событиях — conventions прецедента add-measurement.test.ts. Матрица
// §20: happy-path (обновлённая запись читается из репозитория, оба события);
// несуществующий id → err NOT_FOUND, БД не изменена; FUTURE_TIME при правке времени
// вперёд → err без изменений; typo пересчитан БЕЗ самой записи (медиана 128 при
// правке на 169); critical по НОВЫМ значениям; duplicate отсутствует в ответе.
// Дополнительно §9/§13: STORAGE/* → err + лог, событий нет; окно истории — 14 дней
// от НОВОГО takenAt кандидата.
import { describe, expect, it, vi } from 'vitest';

import { AppError, FixedClock, unsafeUnwrap } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../adapters/measurement-repo.fake.js';
import { BpMeasurement } from '../domain/bp-measurement.js';
import type { EditMeasurementCommand } from '../domain/measurement-commands.js';
import { UpdateMeasurementUseCase } from './update-measurement.js';
import type { BpMeasurementRepository } from './ports/bp-measurement-repository.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10, прецедент доменных тестов. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const clock = new FixedClock(NOW_MS, TZ);

/** Подставочные зависимости: события и логгер — vi.fn-шпионы (§19: «spy events»). */
const makeEvents = () => ({
  emit: vi.fn<(name: string, payload: unknown) => void>(() => {}),
});
const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

/** Команда правки по умолчанию: валидная, минуту назад от «сейчас» Clock'а. */
const command = (overrides: Partial<EditMeasurementCommand> = {}): EditMeasurementCommand => ({
  sys: 120,
  dia: 80,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  takenAt: { utcMs: NOW_MS - MINUTE_MS, tzOffsetMin: TZ },
  ...overrides,
});

/** Существующая запись: агрегат через фабрику домена (единственный путь, TASK-017). */
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
  useCase: UpdateMeasurementUseCase;
  events: ReturnType<typeof makeEvents>;
  logger: ReturnType<typeof makeLogger>;
} => ({
  useCase: new UpdateMeasurementUseCase({ repo, clock, events, logger }),
  events,
  logger,
});

describe('UpdateMeasurementUseCase — happy path (§20)', () => {
  it('ok: обновлённая запись читается из репозитория, оба события по порядку', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase, events, logger } = makeUseCase(repo);
    const existing = record(125, 82, NOW_MS - 5 * MINUTE_MS);
    await repo.add(existing);

    const result = await useCase.execute({
      id: existing.id,
      ...command({ sys: 130, dia: 84, note: 'исправлено', arm: 'right' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Наследование неизменяемого: id, profileId, source, createdAtUtc (edit TASK-017);
    // новые значения и updatedAtUtc = «сейчас» Clock'а.
    expect(result.value.measurement).toMatchObject({
      id: existing.id,
      profileId: 'profile-1',
      sys: 130,
      dia: 84,
      pulse: 70,
      arm: 'right',
      note: 'исправлено',
      source: 'manual',
      takenAtUtcMs: NOW_MS - MINUTE_MS,
      tzOffsetMin: TZ,
      createdAtUtcMs: NOW_MS,
      updatedAtUtcMs: NOW_MS,
    });
    // Запись реально обновлена в fake-repo (§20 п. 1: читается из репозитория).
    const stored = await repo.getById(existing.id);
    expect(stored?.bp.sys).toBe(130);
    expect(stored?.bp.dia).toBe(84);
    expect(stored?.note).toBe('исправлено');
    // События: оба, только при успехе; порядок — как в add/delete (§22: единый стиль).
    expect(events.emit.mock.calls.map((call) => call[0])).toEqual([
      'measurement:changed',
      'data:versionBumped',
    ]);
    expect(events.emit).toHaveBeenCalledWith('measurement:changed', { profileId: 'profile-1' });
    // data_version: 1 (старт) → 2 (add) → 3 (update, §13 порта TASK-021).
    expect(events.emit).toHaveBeenCalledWith('data:versionBumped', { newVersion: 3 });
    // Лог §18: durationMs + flags=[] — БЕЗ значений измерений (PHI, TASK-010).
    expect(logger.info).toHaveBeenCalledWith(
      'updateMeasurement',
      expect.objectContaining({ flags: [] }),
    );
    const infoMeta = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof infoMeta?.['durationMs']).toBe('number');
    expect(infoMeta).not.toHaveProperty('sys');
    expect(infoMeta).not.toHaveProperty('note');
  });
});

describe('UpdateMeasurementUseCase — NOT_FOUND (§20)', () => {
  it('несуществующий id: err MEASUREMENT/NOT_FOUND, БД не изменена, событий нет', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const updateSpy = vi.spyOn(repo, 'update');
    const { useCase, events, logger } = makeUseCase(repo);
    const untouched = record(120, 80, NOW_MS - MINUTE_MS);
    await repo.add(untouched);

    const result = await useCase.execute({ id: 'no-such-id', ...command() });

    expect(result).toMatchObject({ ok: false, error: { code: 'MEASUREMENT/NOT_FOUND' } });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // БД не изменена: другая запись цела, data_version не бампнулась (2 после add).
    expect((await repo.getById(untouched.id))?.bp.sys).toBe(120);
    expect(await repo.currentDataVersion()).toBe(2);
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe('UpdateMeasurementUseCase — FUTURE_TIME (§20)', () => {
  it('правка времени вперёд: err MEASUREMENT/FUTURE_TIME, запись без изменений, событий нет', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const updateSpy = vi.spyOn(repo, 'update');
    const { useCase, events } = makeUseCase(repo);
    const existing = record(125, 82, NOW_MS - 5 * MINUTE_MS);
    await repo.add(existing);

    const result = await useCase.execute({
      id: existing.id,
      ...command({ takenAt: { utcMs: NOW_MS + MINUTE_MS, tzOffsetMin: TZ } }),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MEASUREMENT/FUTURE_TIME' } });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // Запись осталась прежней (§20: err без изменений).
    const stored = await repo.getById(existing.id);
    expect(stored?.bp.sys).toBe(125);
    expect(stored?.takenAt.utcMs).toBe(NOW_MS - 5 * MINUTE_MS);
  });
});

describe('UpdateMeasurementUseCase — typo пересчитан без самой записи (§13/§20)', () => {
  it('правка на 169 при медиане 128 (две другие записи) → flags.typo присутствует (§20)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - 10 * DAY_MS;
    const existing = record(128, 82, T0);
    await repo.add(existing);
    await repo.add(record(128, 82, T0 - 1 * DAY_MS));
    await repo.add(record(128, 82, T0 - 2 * DAY_MS));

    const result = await useCase.execute({
      id: existing.id,
      ...command({ sys: 169, dia: 82, takenAt: { utcMs: T0, tzOffsetMin: TZ } }),
    });

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
  });

  it('старое значение правимой записи НЕ участвует в медиане: [100, 150] → медиана 125 (без него было бы 140)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - 10 * DAY_MS;
    const existing = record(140, 82, T0); // старое значение 140 — в окне, но id≠-фильтр
    await repo.add(existing);
    await repo.add(record(100, 82, T0 - 1 * DAY_MS));
    await repo.add(record(150, 82, T0 - 2 * DAY_MS));

    const result = await useCase.execute({
      id: existing.id,
      ...command({ sys: 169, dia: 82, takenAt: { utcMs: T0, tzOffsetMin: TZ } }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Исключая правимую: [100, 150] → медиана 125, отклонение 44 > 40 → флаг.
    // Если бы старое 140 участвовало: [100, 140, 150] → медиана 140, отклонение 29 — флага нет.
    expect(result.value.flags.typo).toEqual({
      field: 'sys',
      median: 125,
      value: 169,
      deviation: 44,
    });
  });

  it('окно истории — от НОВОГО takenAt кандидата: записи ПОЗЖЕ кандидата не сравниваются', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const { useCase } = makeUseCase(repo);
    const T0 = NOW_MS - 10 * DAY_MS; // кандидат задним числом (US-3)
    const existing = record(128, 82, T0);
    await repo.add(existing);
    // Позднее кандидата (но до «сейчас»): вне окна кандидата — иначе медиана 100.
    await repo.add(record(100, 82, T0 + 1 * DAY_MS));
    await repo.add(record(100, 82, T0 + 2 * DAY_MS));

    const result = await useCase.execute({
      id: existing.id,
      ...command({ sys: 169, dia: 82, takenAt: { utcMs: T0, tzOffsetMin: TZ } }),
    });

    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        fromUtcMs: T0 - 14 * DAY_MS,
        toUtcMs: T0,
        limit: 100,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // История пуста (правимая исключена, поздние вне окна) → подсказки нет.
    expect(result.value.flags.typo).toBeUndefined();
  });
});

describe('UpdateMeasurementUseCase — critical по НОВЫМ значениям (§13/§20)', () => {
  it('старое 200/130 (критичное) правится на 120/80 → criticalValue отсутствует', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const existing = record(200, 130, NOW_MS - MINUTE_MS);
    await repo.add(existing);

    const result = await useCase.execute({ id: existing.id, ...command({ sys: 120, dia: 80 }) });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags.criticalValue).toBeUndefined();
  });

  it('правка на 200/130 → criticalValue=high; на 85/55 → low (границы включительно, TASK-020)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    const first = record(120, 80, NOW_MS - 2 * MINUTE_MS);
    await repo.add(first);
    const high = await useCase.execute({ id: first.id, ...command({ sys: 200, dia: 130 }) });
    expect(high.ok).toBe(true);
    if (high.ok) {
      expect(high.value.flags.criticalValue).toBe('high');
    }

    const second = record(120, 80, NOW_MS - MINUTE_MS);
    await repo.add(second);
    const low = await useCase.execute({ id: second.id, ...command({ sys: 85, dia: 55 }) });
    expect(low.ok).toBe(true);
    if (low.ok) {
      expect(low.value.flags.criticalValue).toBe('low');
    }
  });
});

describe('UpdateMeasurementUseCase — контракт формы ответа (§20: duplicate отсутствует)', () => {
  it('флаги ответа не содержат duplicate (правка не создаёт дубль-риск — решение §5)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    // Сосед-«дубль» в окне: update НЕ пересчитывает duplicate (§5) — и в ответе его нет.
    const existing = record(120, 80, NOW_MS - MINUTE_MS);
    await repo.add(existing);
    await repo.add(record(120, 80, NOW_MS - 2 * MINUTE_MS));

    const result = await useCase.execute({ id: existing.id, ...command() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.flags).not.toHaveProperty('duplicate');
    expect(result.value.flags).toEqual({ criticalValue: undefined });
  });
});

describe('UpdateMeasurementUseCase — отказ хранения (§9)', () => {
  it('STORAGE/*: update упал → err, событий нет, в логе есть отказ', async () => {
    const storageError = AppError.of('STORAGE/FAILED', 'errors.STORAGE_FAILED');
    const base = new InMemoryBpMeasurementRepository();
    // Стаб порта: методы — делегирование в fake, update — отказ STORAGE/FAILED
    // (spread класса методы прототипа не копирует — стаб собирается явно, прецедент add).
    const failingRepo: BpMeasurementRepository = {
      add: (m) => base.add(m),
      update: () => Promise.resolve({ ok: false, error: storageError }),
      delete: (id) => base.delete(id),
      getById: (id) => base.getById(id),
      listByPeriod: (q) => base.listByPeriod(q),
      countByPeriod: (q) => base.countByPeriod(q),
      currentDataVersion: () => base.currentDataVersion(),
    };
    const { useCase, events, logger } = makeUseCase(failingRepo);
    const existing = record(120, 80, NOW_MS - MINUTE_MS);
    await base.add(existing);

    const result = await useCase.execute({ id: existing.id, ...command({ sys: 130 }) });

    expect(result).toMatchObject({ ok: false, error: { code: 'STORAGE/FAILED' } });
    expect(events.emit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
