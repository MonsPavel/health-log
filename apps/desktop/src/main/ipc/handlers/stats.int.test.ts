// TASK-054 §11/§15/§19/§20: интеграционный тест канала `stats/period` — полный путь
// «запрос рендерера → каркас (zod) → GetPeriodStatistics → адаптер точек → read model
// 052 + классификация 053 (шкала ScaleService) → шифрованная SQLite» через контейнер
// (прецеденты measurements.int.test.ts / scales.int.test.ts). Матрица:
//  1. фикстура (a) classic30, период 'all' → DTO глубоко равен golden-эталону 052
//     + classification (normal + обе заметки 053); ответ парсится схемой канала
//     (schema-тест DTO↔zod, AC3) и равен read model, собранному в процессе (§22 —
//     тест дрейфа из реального ответа, не ручная копия);
//  2. фикстура (d) threeRecords — мало данных: insufficientData оба true,
//     classification.category undefined (вердикта нет — EC-09), note insufficientData;
//  3. пустая БД → ok, count=0, полная структура с нулями/undefined — НЕ ошибка
//     (§11, AC2); «всё» на пустой БД — дым (§13);
//  4. period='30d' ровно на границе записи — включительно (§13, TASK-044);
//  5. custom-период из одного дня — обе границы включительно (§13, TASK-046);
//  6. детерминизм: одинаковые запросы — одинаковые ответы (§13);
//  7. «всё» на 5000 записей — замер ≤300 мс (§15, AC5);
//  8. каркас: мусорный payload → VALIDATION/FAILED до хендлера (§14).
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STATS_RESPONSE_SCHEMA, type PeriodStatisticsDto } from '@hl/contracts';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
import { AppError, FixedClock, type Result } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';
import type { MeasurementPoint } from '../../modules/analytics/application/ports/measurement-points.js';
import { INSUFFICIENT_DATA_NOTE_TEXT } from '../../modules/analytics/domain/classifier.js';
import { buildPeriodStatistics } from '../../modules/analytics/application/period-statistics.js';
import {
  fixtureInstant,
  GOLDEN_FIXTURES,
} from '../../modules/analytics/application/__fixtures__/periods.js';

/** Фиксированный тестовый ключ мок-vault (§19). */
const KEY_HEX = 'ab'.repeat(32);

/** «Сейчас» FixedClock — после всех фикстурных дат (2026-03-31T12:00+03:00). */
const NOW_MS = fixtureInstant('2026-03-31', '12:00').utcMs;
/** Пояс фикстур +03:00 → 180 минут (записи вставляются с их собственным offset). */
const TZ = 180;

/** Свежий tmp-userData; удаление — в конце кейса (§14). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-stats-int-'));

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

/** Вставляет точки фикстур через канал measurements/add (полный путь записи). */
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
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs: point.takenAt.utcMs, tzOffsetMin: point.takenAt.tzOffsetMin },
      },
    });
    expect(envelope).toMatchObject({ ok: true });
  }
};

/** Вызов stats/period через каркас. */
const statsRequest = (
  container: Awaited<ReturnType<typeof makeContainer>>,
  payload: unknown,
): ReturnType<typeof container.channels.dispatch> =>
  container.channels.dispatch({ channel: 'stats/period', payload });

/** Golden-фикстура по префиксу имени (без non-null assertion; ошибка — явный throw). */
function fixture(namePrefix: string) {
  const found = GOLDEN_FIXTURES.find((f) => f.name.startsWith(namePrefix));
  if (found === undefined) {
    throw new Error(`golden-фикстура ${namePrefix} не найдена`);
  }
  return found;
}

/** Категория шкалы по коду (эталон classification для фикс. (a)). */
function scaleCategory(code: string) {
  const found = BP_OFFICE_ESC2018.categories.find((category) => category.code === code);
  if (found === undefined) {
    throw new Error(`категория ${code} не найдена в данных шкалы`);
  }
  return found;
}

describe('stats/period через контейнер — полный путь (TASK-054 §20)', () => {
  it('(1) фикстура (a) classic30 через канал «all» — DTO глубоко равен golden-эталону + classification; ответ парсится схемой и равен read model (AC1/AC3, §22)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const golden = fixture('classic30');
      await addPoints(container, golden.points());

      const envelope = await statsRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }

      // Schema-тест DTO↔zod: реальный ответ канала валиден контрактом (AC3).
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.scale).toEqual({
        code: BP_OFFICE_ESC2018.code,
        version: BP_OFFICE_ESC2018.version,
        sourceLabel: BP_OFFICE_ESC2018.sourceLabel,
      });

      // Эталон = golden-фикстура 052 + classification 053 (normal + обе заметки).
      const expected: PeriodStatisticsDto = {
        ...golden.expected,
        classification: {
          category: scaleCategory('normal'),
          notes: [
            { kind: 'homeBP', text: BP_OFFICE_ESC2018.homeBPNote },
            { kind: 'specialGroups', text: BP_OFFICE_ESC2018.specialGroupsNote },
          ],
        },
      };
      expect(parsed.stats).toEqual(expected);

      // Тест дрейфа DTO от read model (§22): сборка в процессе на тех же точках —
      // канал отдал ровно структуру 052/053, без потерь маппинга.
      expect(parsed.stats).toEqual(buildPeriodStatistics(golden.points(), BP_OFFICE_ESC2018));
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('(2) фикстура (d) threeRecords — мало данных: insufficientData оба true, категории-вердикта нет, note insufficientData (AC4, EC-09)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const golden = fixture('threeRecords');
      await addPoints(container, golden.points());

      const envelope = await statsRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);

      expect(parsed.stats.insufficientData).toEqual({ tooFewMeasurements: true, tooFewDays: true });
      // Категория в данных undefined — UI не может показать её как вывод (§10);
      // пометка «мало данных» присутствует заметкой (§2/§3).
      expect(parsed.stats.classification).toEqual({
        category: undefined,
        notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
      });
      // Значения при этом посчитаны (честные цифры с пометкой, §3): эталон 052
      // целиком + insufficient-classification 053.
      expect(parsed.stats.count).toBe(3);
      expect(parsed.stats).toEqual({
        ...golden.expected,
        classification: {
          category: undefined,
          notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
        },
      });
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) пустая БД → ok, count=0, полная структура с нулями/undefined, classification insufficient — не ошибка (§11, AC2)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await statsRequest(container, { profileId: 'profile-1', period: '30d' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.stats).toEqual({
        count: 0,
        sys: {},
        dia: {},
        critical: { high: false, low: false },
        daysWithMeasurements: 0,
        longestStreakDays: 0,
        insufficientData: { tooFewMeasurements: true, tooFewDays: true },
        classification: {
          category: undefined,
          notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
        },
      });
      expect('lastMeasurementUtcMs' in parsed.stats).toBe(false);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3b) «всё» на пустой БД — дым: ok, count=0 (§13)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await statsRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.stats.count).toBe(0);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) period=30d ровно на границе записи — включительно (§13, TASK-044: from = now − N*24ч)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const boundaryUtcMs = NOW_MS - 30 * 24 * 60 * 60 * 1000;
      await addPoints(container, [
        {
          sys: 122,
          dia: 81,
          pulse: 63,
          takenAt: { utcMs: boundaryUtcMs, tzOffsetMin: TZ },
          critical: undefined,
        },
        {
          sys: 121,
          dia: 80,
          pulse: 62,
          takenAt: { utcMs: boundaryUtcMs - 1, tzOffsetMin: TZ },
          critical: undefined,
        },
      ]);

      const envelope = await statsRequest(container, { profileId: 'profile-1', period: '30d' });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);
      // Запись ровно на границе включена, на 1 мс старее — нет.
      expect(parsed.stats.count).toBe(1);
      expect(parsed.stats.lastMeasurementUtcMs).toBe(boundaryUtcMs);
      expect(parsed.stats.sys.min).toBe(122);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) custom-период из одного дня — обе границы включительно (§13, TASK-046)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const fromUtcMs = fixtureInstant('2026-03-05', '00:00').utcMs;
      const toUtcMs = fixtureInstant('2026-03-05', '23:59').utcMs;
      await addPoints(container, [
        {
          sys: 120,
          dia: 80,
          pulse: 60,
          takenAt: { utcMs: fromUtcMs, tzOffsetMin: TZ },
          critical: undefined,
        },
        {
          sys: 122,
          dia: 81,
          pulse: 62,
          takenAt: { utcMs: toUtcMs, tzOffsetMin: TZ },
          critical: undefined,
        },
        {
          sys: 125,
          dia: 85,
          pulse: 65,
          takenAt: { utcMs: toUtcMs + 60_000, tzOffsetMin: TZ },
          critical: undefined,
        },
        {
          sys: 118,
          dia: 79,
          pulse: 58,
          takenAt: { utcMs: fromUtcMs - 60_000, tzOffsetMin: TZ },
          critical: undefined,
        },
      ]);

      const envelope = await statsRequest(container, {
        profileId: 'profile-1',
        period: { fromUtcMs, toUtcMs },
      });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);
      // Точки на обеих границах включены; соседние дни — нет.
      expect(parsed.stats.count).toBe(2);
      expect(parsed.stats.daysWithMeasurements).toBe(1);
      expect(parsed.stats.lastMeasurementUtcMs).toBe(toUtcMs);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6) детерминизм: одинаковые запросы — одинаковые ответы (§13)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addPoints(container, fixture('threeRecords').points());

      const first = await statsRequest(container, { profileId: 'profile-1', period: 'all' });
      const second = await statsRequest(container, { profileId: 'profile-1', period: 'all' });
      expect(second).toEqual(first);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(7) «всё» на 5000 записей — замер ≤300 мс в тест-логе (§15, AC5; полный NFR — TASK-111)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      // Сид 5000 записей одним prepared statement в транзакции (перф-цель — на
      // чтение канала, не на вставку): 500 дней × 10 слотов, значения без критики.
      const insert = container.db.prepare(
        `INSERT INTO bp_measurement (
           id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse,
           irregular_pulse, arm, note, source, created_at_utc, updated_at_utc
         ) VALUES (?, 'profile-1', ?, ?, 120, 80, 60, 0, 'left', NULL, 'manual', ?, ?)`,
      );
      const created = NOW_MS - 600 * 24 * 60 * 60 * 1000;
      const seed = container.db.transaction(() => {
        for (let day = 0; day < 500; day += 1) {
          for (let slot = 0; slot < 10; slot += 1) {
            const utcMs = created + day * 24 * 60 * 60 * 1000 + slot * 60 * 60 * 1000;
            insert.run(`seed-${day}-${slot}`, utcMs, TZ, created, created);
          }
        }
      });
      seed();

      const startedAtMs = performance.now();
      const envelope = await statsRequest(container, { profileId: 'profile-1', period: 'all' });
      const durationMs = Math.round(performance.now() - startedAtMs);
      console.info(`[stats.int] stats/period period=all count=5000 durationMs=${durationMs}`);

      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = STATS_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.stats.count).toBe(5000);
      expect(
        durationMs,
        `stats/period «всё» на 5000 записей: ${durationMs} мс — бюджет канала §15 (300 мс)`,
      ).toBeLessThanOrEqual(300);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('(8) каркас: мусорный payload → VALIDATION/FAILED до хендлера (§14)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      for (const payload of [
        { period: '30d' }, // нет profileId
        { profileId: 'profile-1', period: '15d' }, // неизвестный пресет
        { profileId: 'profile-1', period: '30d', arm: 'left' }, // лишнее поле (strict)
        { profileId: '', period: '30d' }, // пустой профиль
      ]) {
        const envelope = await statsRequest(container, payload);
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
