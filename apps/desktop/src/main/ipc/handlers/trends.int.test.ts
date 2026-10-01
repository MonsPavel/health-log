// TASK-056 §11/§15/§19/§20: интеграционный тест канала `trend/series` — полный путь
// «запрос рендерера → каркас (zod) → TrendSeries → адаптер точек → шифрованная
// SQLite» через контейнер (прецедент stats.int.test.ts TASK-054). Матрица:
//  1. малые данные через measurements/add (полный путь записи) → raw-режим:
//     part по правилу дня TASK-052, critical сквозной от политики TASK-020
//     (190/125 → high — §20 AC3), сортировка utc asc;
//  2. пустая БД → {mode:'raw', points:[]} — не ошибка (§11, §20 AC5);
//  3. порог через контейнер: 501 точка (167 дней × 3 слота) → daily, агрегаты дня
//     верны (avg/min/max + morning/evening раздельно), days сортирован wallDate asc;
//  4. сортировка asc стабильна сквозно: tie-break id (§9, §20 AC4) — SQL-сид двух
//     записей с равным takenAt в порядке id, обратном asc (репозиторий отдаёт DESC).
//     На проводе id нет — порядок виден по значениям;
//  5. порог считается по точкам ПЕРИОДА (§7): 600 точек в базе, custom-период
//     на 100 дней → raw с 100 точками;
//  6. 10k записей → daily за бюджет §15 (сборка ≤200 мс — юнит-тест budget'а в
//     trend-series.test.ts; здесь — замер канала в лог, рендер — TASK-062);
//  7. каркас: мусорный payload → VALIDATION/FAILED до хендлера (§14).
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TREND_RESPONSE_SCHEMA, type RawPoint } from '@hl/contracts';
import { AppError, FixedClock, Instant, type Result, ok } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';
import type { MeasurementPoint } from '../../modules/analytics/application/ports/measurement-points.js';
import { fixtureInstant } from '../../modules/analytics/application/__fixtures__/periods.js';

/** Фиксированный тестовый ключ мок-vault (§19). */
const KEY_HEX = 'ab'.repeat(32);

/** «Сейчас» FixedClock — после всех фикстурных дат. */
const NOW_MS = fixtureInstant('2026-12-31', '12:00').utcMs;

/** Пояс фикстур +03:00 → 180 минут (записи вставляются с их собственным offset). */
const TZ = 180;

/** Свежий tmp-userData; удаление — в конце кейса (§14). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-trend-int-'));

/** Мок-vault (§19): фиксированный ключ без safeStorage. */
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

/** Контейнер на tmp-userData с профилем-владельцем (FK v1, прецедент TASK-030). */
const makeContainer = async (dir: string) => {
  const container = await buildContainer({
    userDataPath: dir,
    clock: new FixedClock(NOW_MS, TZ),
    vault: () => new MockVault(),
  });
  container.db
    .prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0)",
    )
    .run();
  return container;
};

/** Вставляет точки через канал measurements/add (полный путь записи). */
const addPoints = async (
  container: Awaited<ReturnType<typeof makeContainer>>,
  points: readonly MeasurementPoint[],
): Promise<void> => {
  for (const point of points) {
    const envelope = await container.channels.dispatch({
      channel: 'measurements/add',
      payload: {
        profileId: 'profile-1',
        sys: point.sys,
        dia: point.dia,
        ...(point.pulse !== undefined ? { pulse: point.pulse } : {}),
        irregularPulse: point.irregular === true,
        arm: 'left',
        takenAt: { utcMs: point.takenAt.utcMs, tzOffsetMin: point.takenAt.tzOffsetMin },
      },
    });
    expect(envelope).toMatchObject({ ok: true });
  }
};

/** Вызов trend/series через каркас. */
const trendRequest = (
  container: Awaited<ReturnType<typeof makeContainer>>,
  payload: unknown,
): ReturnType<typeof container.channels.dispatch> =>
  container.channels.dispatch({ channel: 'trend/series', payload });

/** Prepared-вставка строки журнала (сид больших данных, прецедент stats (7)). */
const insertStatement = (container: Awaited<ReturnType<typeof makeContainer>>) =>
  container.db.prepare(
    `INSERT INTO bp_measurement (
       id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse,
       irregular_pulse, arm, note, source, created_at_utc, updated_at_utc
     ) VALUES (?, 'profile-1', ?, ?, ?, ?, NULL, 0, 'left', NULL, 'manual', ?, ?)`,
  );

/** utcMs настенного 00:00 дня в поясе фикстур — база дня для слотов. */
const dayStartUtcMs = (dayIso: string): number =>
  Instant.fromIso(`${dayIso}T00:00:00.000+03:00`).utcMs;

describe('trend/series через контейнер — полный путь (TASK-056 §20)', () => {
  it('(1) малые данные → raw: part по правилу дня, critical сквозной (190/125 → high), irregular сквозной (EC-10, 058 §9), сортировка asc (AC3, §20)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      // Точки вставляются в обратном порядке — сортировку asc видна по значениям.
      await addPoints(container, [
        {
          sys: 124,
          dia: 84,
          pulse: 72,
          takenAt: fixtureInstant('2026-03-02', '20:00'),
          critical: undefined,
        },
        {
          sys: 122,
          dia: 82,
          pulse: undefined,
          takenAt: fixtureInstant('2026-03-02', '12:30'),
          critical: undefined,
        },
        {
          sys: 190,
          dia: 125,
          pulse: 90,
          takenAt: fixtureInstant('2026-03-02', '07:30'),
          critical: 'high',
          // TASK-058 §9: флаг «неровный пульс» записи — до сырой точки канала.
          irregular: true,
        },
      ]);

      const envelope = await trendRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      // Schema-тест: реальный ответ канала валиден контрактом.
      const parsed = TREND_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.mode).toBe('raw');

      const points = parsed.points as RawPoint[];
      expect(points.map((p) => p.sys)).toEqual([190, 122, 124]);
      expect(points.map((p) => p.part)).toEqual(['morning', 'other', 'evening']);
      // critical — политика TASK-020, поставленная адаптером порта, прокинута read model'ом;
      // irregular — флаг записи (EC-10), прокинут сквозно адаптером порта (058 §9).
      expect(points[0]).toMatchObject({
        critical: 'high',
        pulse: 90,
        sys: 190,
        dia: 125,
        irregular: true,
      });
      expect('critical' in points[1]!).toBe(false);
      expect('pulse' in points[1]!).toBe(false);
      expect('irregular' in points[1]!).toBe(false);
      expect('irregular' in points[2]!).toBe(false);
      // arm — TASK-059 §5: рука записи сквозно (measurements/add → адаптер порта →
      // read model) — колонка «Рука» таблицы-альтернативы строится из этого провода.
      expect(points[0]?.arm).toBe('left');
      expect(points[1]?.arm).toBe('left');
      // Момент — как хранится (свой offset записи, EC-06).
      expect(points[0]?.tzOffsetMin).toBe(TZ);
      expect(points[0]?.utcMs).toBe(fixtureInstant('2026-03-02', '07:30').utcMs);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('(2) пустая БД → {mode:"raw", points:[]} — не ошибка (§11, AC5)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await trendRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = TREND_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed).toEqual({ mode: 'raw', points: [] });
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) 501 точка (167 дней × 3 слота) → daily: агрегаты дня верны, days сортирован wallDate asc (§13)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      // Слоты дня (минуты суток): утро 07:00=420 (120/80), день 12:30=750 (126/84),
      // вечер 20:00=1200 (132/88): sysAvg 126, diaAvg 84, morningSysAvg 120,
      // eveningSysAvg 132, count 3.
      const insert = insertStatement(container);
      const seed = container.db.transaction(() => {
        for (let day = 0; day < 167; day += 1) {
          const base = dayStartUtcMs('2025-01-01') + day * 86_400_000;
          const slots: ReadonlyArray<[number, number, number]> = [
            [420, 120, 80],
            [750, 126, 84],
            [1200, 132, 88],
          ];
          for (const [wallMinutes, sys, dia] of slots) {
            const utcMs = base + wallMinutes * 60_000;
            insert.run(`seed-${day}-${wallMinutes}`, utcMs, TZ, sys, dia, base, base);
          }
        }
      });
      seed();

      const envelope = await trendRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = TREND_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.mode).toBe('daily');
      expect('points' in parsed).toBe(false);
      expect(parsed.days?.length).toBe(167);
      expect(parsed.days?.[0]).toEqual({
        wallDate: '2025-01-01',
        sysAvg: 126,
        sysMin: 120,
        sysMax: 132,
        diaAvg: 84,
        diaMin: 80,
        diaMax: 88,
        morningSysAvg: 120,
        eveningSysAvg: 132,
        count: 3,
      });
      // wallDate asc по всему ответу (§13).
      const dates = (parsed.days ?? []).map((day) => day.wallDate);
      for (let i = 1; i < dates.length; i += 1) {
        expect(dates[i]?.localeCompare(dates[i - 1] ?? '')).toBeGreaterThan(0);
      }
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('(4) tie-break id сквозно: равные takenAt — порядок id asc, не порядок вставки (AC4, §9)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const sameUtc = fixtureInstant('2026-03-02', '08:00').utcMs;
      const insert = insertStatement(container);
      // Репозиторий отдаёт taken_at_utc DESC, id DESC (TASK-021 §13): [id-b, id-a].
      // Read model пересортировывает asc c tie-break id → на проводе [121 (id-a), 122 (id-b)].
      insert.run('id-b', sameUtc, TZ, 122, 82, sameUtc, sameUtc);
      insert.run('id-a', sameUtc, TZ, 121, 81, sameUtc, sameUtc);

      const envelope = await trendRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = TREND_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.mode).toBe('raw');
      expect(parsed.points?.map((p) => p.sys)).toEqual([121, 122]);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) порог считается по точкам ПЕРИОДА: 600 в базе, custom на 100 дней → raw с 100 точками (§7)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const insert = insertStatement(container);
      const seed = container.db.transaction(() => {
        for (let day = 0; day < 600; day += 1) {
          const base = dayStartUtcMs('2025-01-01') + day * 86_400_000;
          insert.run(`seed-${day}`, base + 7 * 3_600_000, TZ, 120, 80, base, base);
        }
      });
      seed();

      // Ровно первые 100 дней (2025-01-01..2025-04-10 — обе границы включительно).
      const envelope = await trendRequest(container, {
        profileId: 'profile-1',
        period: {
          fromUtcMs: dayStartUtcMs('2025-01-01'),
          toUtcMs: dayStartUtcMs('2025-04-10') + 23 * 3_600_000 + 59 * 60_000,
        },
      });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = TREND_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.mode).toBe('raw');
      expect(parsed.points?.length).toBe(100);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('(6) 10k записей → daily: 1000 дней × 10; замер канала в лог (сборка ≤200 мс — юнит-бюджет; рендер — TASK-062)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const insert = insertStatement(container);
      const seed = container.db.transaction(() => {
        const hours = [6, 7, 8, 9, 10, 11, 18, 19, 20, 21];
        for (let day = 0; day < 1000; day += 1) {
          const base = dayStartUtcMs('2025-01-01') + day * 86_400_000;
          for (const [slot, hour] of hours.entries()) {
            const utcMs = base + hour * 3_600_000;
            insert.run(`seed-${day}-${slot}`, utcMs, TZ, 118 + slot * 2, 78 + slot, base, base);
          }
        }
      });
      seed();

      const startedAtMs = performance.now();
      const envelope = await trendRequest(container, { profileId: 'profile-1', period: 'all' });
      const durationMs = Math.round(performance.now() - startedAtMs);
      console.info(
        `[trend.int] trend/series period=all mode=daily days=1000 durationMs=${durationMs}`,
      );

      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = TREND_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.mode).toBe('daily');
      expect(parsed.days?.length).toBe(1000);
      expect(parsed.days?.[0]?.count).toBe(10);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('(7) каркас: мусорный payload → VALIDATION/FAILED до хендлера (§14)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      for (const payload of [
        { period: '30d' }, // нет profileId
        { profileId: 'profile-1', period: '15d' }, // неизвестный пресет
        { profileId: 'profile-1', period: '30d', arm: 'left' }, // лишнее поле (strict)
        { profileId: '', period: 'all' }, // пустой профиль
      ]) {
        const envelope = await trendRequest(container, payload);
        expect(envelope).toMatchObject({ ok: false });
        if (!envelope.ok) {
          expect(envelope.error.code).toBe('VALIDATION/FAILED');
        }
      }
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
