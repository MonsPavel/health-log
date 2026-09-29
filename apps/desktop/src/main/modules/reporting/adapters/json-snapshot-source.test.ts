// TASK-065 §5/§8/§11: юниты боевого адаптера JsonSnapshotSource (reporting/adapters) —
// перенос инлайн-источников roundtrip-теста 064 (reporting-export-json.int.test.ts,
// шапка: «вынесение адаптеров в reporting/adapters — TASK-065»). Матрица:
//  - getProfile: строка таблицы profile (v1) → форма JsonSnapshotProfile; отсутствует →
//    undefined (§9: пустой слепок — не ошибка);
//  - listMeasurements: журнал порта репозитория → MeasurementDto (маппинг add-measurement,
//    контракт 028) — use case 064 разворачивает desc→asc сам;
//  - скоуп профиля (§14): listByPeriod зовётся с {profileId} без расширений.
import { describe, expect, it, vi } from 'vitest';

import { FixedClock, Instant, unsafeUnwrap } from '@hl/kernel';

import { BpMeasurement } from '../../measurement/domain/bp-measurement.js';
import { JsonSnapshotSource } from './json-snapshot-source.js';

const NOW_MS = 1_790_341_200_000;
const TZ = 180;
const PROFILE = 'profile-1';

/** Агрегат журнала (боевой домен) — фикстура для маппинга DTO. */
const measurement = (): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: PROFILE,
        sys: 118,
        dia: 76,
        pulse: undefined,
        irregularPulse: true,
        arm: 'right',
        note: undefined,
        takenAt: Instant.fromIso('2026-09-20T07:45:00.000+03:00'),
      },
      new FixedClock(NOW_MS, TZ),
    ),
  );

describe('JsonSnapshotSource — адаптер источника слепка (TASK-065 §8)', () => {
  it('getProfile: строка profile-таблицы → {id, name, createdAtUtc}; нет строки → undefined (§9)', async () => {
    const rows = new Map<string, { id: string; name: string; created_at_utc: number }>([
      [PROFILE, { id: PROFILE, name: 'Тест', created_at_utc: 42 }],
    ]);
    const prepare = vi.fn(() => ({
      get: (id: string) => rows.get(id),
    }));
    const source = new JsonSnapshotSource({
      db: { prepare } as unknown as Parameters<typeof JsonSnapshotSource>[0]['db'],
      repo: { listByPeriod: vi.fn() },
    });

    await expect(source.getProfile(PROFILE)).resolves.toEqual({
      id: PROFILE,
      name: 'Тест',
      createdAtUtc: 42,
    });
    await expect(source.getProfile('nope')).resolves.toBeUndefined();
    // SQL — чтение одной строки по id (v1: id/name/created_at_utc).
    expect(prepare).toHaveBeenCalledWith(
      'SELECT id, name, created_at_utc FROM profile WHERE id = ?',
    );
  });

  it('listMeasurements: агрегаты порта → MeasurementDto (пульс не измерен — ключа нет, 028)', async () => {
    const m = measurement();
    const listByPeriod = vi.fn(() => Promise.resolve([m]));
    const source = new JsonSnapshotSource({
      db: { prepare: vi.fn() } as unknown as Parameters<typeof JsonSnapshotSource>[0]['db'],
      repo: { listByPeriod },
    });

    const dtos = await source.listMeasurements(PROFILE);

    // Скоуп (§14): запрос строго по profileId, без фильтров-расширений.
    expect(listByPeriod).toHaveBeenCalledWith({ profileId: PROFILE });
    expect(dtos).toHaveLength(1);
    expect(dtos[0]).toMatchObject({
      id: m.id,
      profileId: PROFILE,
      sys: 118,
      dia: 76,
      irregularPulse: true,
      arm: 'right',
      takenAtUtcMs: Instant.fromIso('2026-09-20T07:45:00.000+03:00').utcMs,
      tzOffsetMin: TZ,
      source: 'manual',
    });
    expect(Object.hasOwn(dtos[0] ?? {}, 'pulse')).toBe(false);
    expect(Object.hasOwn(dtos[0] ?? {}, 'note')).toBe(false);
  });
});
