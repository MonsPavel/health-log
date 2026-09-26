// TASK-030 §19: юниты use case ListMeasurements на fake-repo (TASK-021). Матрица:
// дефолты (limit=200/offset=0), clamp limit>500 → 500 — тихо, лог debug (§13; §20 п. 3:
// limit 9999 → отдало ≤500), отрицательный offset → 0, пустой период → {items: [],
// total: 0} — не ошибка (§11), маппинг DTO (§7: плоская форма, опционалы без пустых
// ключей), total = COUNT по тем же фильтрам БЕЗ ключей пагинации (§7), фильтры
// передаются в оба метода порта, debug-лог длительности (§18, без PHI).
import { describe, expect, it, vi } from 'vitest';

import { FixedClock, unsafeUnwrap } from '@hl/kernel';

import { InMemoryBpMeasurementRepository } from '../adapters/measurement-repo.fake.js';
import { BpMeasurement } from '../domain/bp-measurement.js';
import type { MeasurementQuery } from './ports/bp-measurement-repository.js';
import { ListMeasurementsUseCase } from './list-measurements.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10, прецедент TASK-029. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;

/** База моментов seed-записей: за час до «сейчас» — все takenAt в прошлом. */
const BASE_MS = NOW_MS - 60 * MINUTE_MS;

/** Запись через фабрику домена (единственный путь создания, TASK-017). */
const record = (
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
      new FixedClock(NOW_MS, TZ),
    ),
  );

/** Подставочные зависимости: логгер — vi.fn-шпион (§19). */
const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

const makeUseCase = (
  repo: InMemoryBpMeasurementRepository = new InMemoryBpMeasurementRepository(),
  logger = makeLogger(),
): { useCase: ListMeasurementsUseCase; repo: InMemoryBpMeasurementRepository; logger: ReturnType<typeof makeLogger> } => ({
  useCase: new ListMeasurementsUseCase({ repo, logger }),
  repo,
  logger,
});

describe('ListMeasurementsUseCase — дефолты (§5/§19)', () => {
  it('без limit/offset → порт получает limit=200, offset=0; total считается тем же use case', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const countSpy = vi.spyOn(repo, 'countByPeriod');
    const { useCase } = makeUseCase(repo);
    await repo.add(record(BASE_MS));

    const page = await useCase.execute({ profileId: 'profile-1' });

    expect(listSpy).toHaveBeenCalledWith({ profileId: 'profile-1', limit: 200, offset: 0 });
    expect(countSpy).toHaveBeenCalledWith({ profileId: 'profile-1' });
    expect(page.items.length).toBe(1);
    expect(page.total).toBe(1);
  });
});

describe('ListMeasurementsUseCase — clamp (§13)', () => {
  it('limit 9999 → порт получает 500; 505 записей → items=500, total=505 (§20 п. 3)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const { useCase, logger } = makeUseCase(repo);
    for (let i = 0; i < 505; i += 1) {
      // В прошлое от BASE_MS (505 минут ≈ 8,4 ч): все takenAt валидны (инвариант
      // «не будущее» домена), newestFirst ставит первой запись i=0.
      await repo.add(record(BASE_MS - i * MINUTE_MS));
    }

    const page = await useCase.execute({ profileId: 'profile-1', limit: 9999 });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
    expect(page.items).toHaveLength(500); // отдаёт ≤500 (§20 п. 3)
    expect(page.total).toBe(505); // total не обрезается — счётчик «N измерений» (§3)
    // §13: clamp тихий — debug-лог с фактом (числа, без PHI), не ошибка.
    expect(logger.debug).toHaveBeenCalledWith(
      'listMeasurements: limit обрезан до максимума',
      expect.objectContaining({ requestedLimit: 9999, limit: 500 }),
    );
  });

  it('отрицательный offset → 0 (§13)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const { useCase } = makeUseCase(repo);

    await useCase.execute({ profileId: 'profile-1', offset: -5 });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('отрицательный limit → 0: пустая страница, а не «без ограничения» (тихая нормализация §13; schema уже отсекает min(0) — защита прямых вызовов)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const { useCase } = makeUseCase(repo);
    await repo.add(record(BASE_MS));

    const page = await useCase.execute({ profileId: 'profile-1', limit: -3 });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 0 }));
    expect(page.items).toEqual([]);
  });
});

describe('ListMeasurementsUseCase — пустой период (§11)', () => {
  it('записей нет → {items: [], total: 0} — не ошибка, пустое состояние рисует UI', async () => {
    const { useCase } = makeUseCase();

    const page = await useCase.execute({
      profileId: 'profile-1',
      fromUtcMs: NOW_MS + MINUTE_MS,
      toUtcMs: NOW_MS + 2 * MINUTE_MS,
    });

    expect(page).toEqual({ items: [], total: 0 });
  });
});

describe('ListMeasurementsUseCase — маппинг DTO (§7)', () => {
  it('bp расплющен в sys/dia, Instant — в takenAtUtcMs/tzOffsetMin; опционалы только при наличии', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    await repo.add(
      record(BASE_MS, {
        sys: 128,
        dia: 82,
        pulse: 70,
        irregularPulse: true,
        arm: 'right',
        note: 'утром',
      }),
    );

    const page = await useCase.execute({ profileId: 'profile-1' });

    expect(page.items[0]).toEqual({
      id: expect.any(String),
      profileId: 'profile-1',
      sys: 128,
      dia: 82,
      pulse: 70,
      irregularPulse: true,
      arm: 'right',
      note: 'утром',
      takenAtUtcMs: BASE_MS,
      tzOffsetMin: TZ,
      source: 'manual',
      createdAtUtcMs: NOW_MS,
      updatedAtUtcMs: NOW_MS,
    });
  });

  it('нет пульса/заметки → ключей pulse/note в DTO нет (чистая форма по проводам, TASK-028 §7)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase } = makeUseCase(repo);
    await repo.add(record(BASE_MS));

    const page = await useCase.execute({ profileId: 'profile-1' });

    expect(page.items[0]).not.toHaveProperty('pulse');
    expect(page.items[0]).not.toHaveProperty('note');
  });
});

describe('ListMeasurementsUseCase — total и фильтры (§7)', () => {
  it('фильтры from/to/arm/hasNote передаются в listByPeriod и countByPeriod; count вызывается БЕЗ limit/offset', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const listSpy = vi.spyOn(repo, 'listByPeriod');
    const countSpy = vi.spyOn(repo, 'countByPeriod');
    const { useCase } = makeUseCase(repo);
    const query: MeasurementQuery = {
      profileId: 'profile-1',
      fromUtcMs: BASE_MS,
      toUtcMs: BASE_MS + 5 * MINUTE_MS,
      arm: 'left',
      hasNote: true,
    };

    await useCase.execute({ ...query, limit: 10, offset: 5 });

    expect(listSpy).toHaveBeenCalledWith({ ...query, limit: 10, offset: 5 });
    // Точное совпадение: лишний ключ limit/offset в запросе счёта нарушил бы equal —
    // total обязан считать ВСЕ подходящие записи, а не страницу (§7).
    expect(countSpy).toHaveBeenCalledWith(query);
  });
});

describe('ListMeasurementsUseCase — телеметрия (§18)', () => {
  it('debug-лог длительности с total; значений измерений в мете нет (PHI, TASK-010)', async () => {
    const repo = new InMemoryBpMeasurementRepository();
    const { useCase, logger } = makeUseCase(repo);
    await repo.add(record(BASE_MS, { note: 'секрет' }));

    await useCase.execute({ profileId: 'profile-1' });

    expect(logger.debug).toHaveBeenCalledWith(
      'listMeasurements',
      expect.objectContaining({ durationMs: expect.any(Number), total: 1 }),
    );
    const meta = logger.debug.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(meta).not.toHaveProperty('note');
    expect(meta).not.toHaveProperty('items');
  });
});
