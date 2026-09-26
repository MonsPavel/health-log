// TASK-026 §19/§20: интеграционные тесты SQLite-адаптера порта репозитория
// (tmp-БД: openEncrypted с фиксированным тестовым ключом hex → миграция v1 → адаптер).
//
// Матрица:
//  - контрактный набор TASK-021 `runRepositoryContract` (группы 1–7 + 8 countByPeriod
//    TASK-030) прогоняется на SqliteBpMeasurementRepository — проверка совместимости
//    с fake (§5: «это и есть проверка совместимости», TASK-021 §3 «fake ≈ адаптер»);
//  - (8) транзакционный fail-point (§13/§19.8/§20): сбой после первого statement →
//    полный rollback — записи нет, data_version прежний;
//  - (9) roundtrip всех полей с pulse=NULL, irregular=true, note с юникодом/эмодзи
//    (§19.9/§20);
//  - ошибки ограничений БД → STORAGE/CONSTRAINT (§9/§20: дубликат id, FK-скоуп);
//    прочая ошибка → STORAGE/FAILED (fail-point, §9);
//  - персистентность: мутации переживают close/reopen (смысл SQLite-адаптера, §2);
//  - profileId-скоуп update: чужой профиль не трогает чужую запись (§14);
//  - dev-контракт profileId: listByPeriod без/с пустым profileId → TypeError —
//    паритет с fake (TASK-021 §20).
//
// Свежая БД для КАЖДОГО теста: шаблон v1 создаётся один раз (openEncrypted →
// MigrationRunner с реальным MIGRATIONS — путь приложения, TASK-027) и клонируется
// копированием файла: фабрика контракта синхронная (TASK-021 §19), а runner.migrate —
// async (hook снапшота, TASK-024 §5); клон байт-в-байт равен «открыл → мигрировал».
// Файлы БД в tmp ОС, закрываются и удаляются в afterAll (§14).
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, unsafeUnwrap, type AppError, type Result } from '@hl/kernel';

import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type { MeasurementQuery } from '../application/ports/bp-measurement-repository.js';
import { BpMeasurement } from '../domain/bp-measurement.js';
import { runRepositoryContract, type RepositoryFactory } from './repository.contract.test.js';
import { SqliteBpMeasurementRepository } from './sqlite-measurement-repository.js';

/** Фиксированный тестовый ключ (§19: фиксированный hex): 32 байта = 64 hex-символа. */
const TEST_KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» — то же, что в контрактном наборе (2025-09-25T16:00:00Z, UTC+3). */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const MINUTE_MS = 60_000;
const BASE_MS = NOW_MS - 60 * MINUTE_MS;

/** Момент измерения: utcMs + общий для тестов пояс (UTC+3). */
const at = (utcMs: number) => ({ utcMs, tzOffsetMin: TZ });

/** Спецификация seed-записи — зеркально контрактному набору (repository.contract.test.ts). */
interface SeedSpec {
  readonly profileId?: string;
  readonly sys?: number;
  readonly dia?: number;
  readonly pulse?: number;
  readonly irregularPulse?: boolean;
  readonly arm?: 'left' | 'right';
  readonly note?: string;
  readonly takenAtUtcMs: number;
}

/** Seed через публичную фабрику create: домен — чёрный ящик и для этого набора (§3). */
const seed = (spec: SeedSpec): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: spec.profileId ?? 'profile-1',
        sys: spec.sys ?? 120,
        dia: spec.dia ?? 80,
        pulse: spec.pulse,
        irregularPulse: spec.irregularPulse ?? false,
        arm: spec.arm ?? 'left',
        note: spec.note,
        takenAt: at(spec.takenAtUtcMs),
      },
      new FixedClock(NOW_MS, TZ),
    ),
  );

/** Извлекает err-ветку для assert'ов; ok-ветка — ошибка теста. */
const errOf = (result: Result<void, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидалась err-ветка Result, получена ok');
  }
  return result.error;
};

describe('SqliteBpMeasurementRepository: SQLite-адаптер порта (TASK-026 §19/§20)', () => {
  /** tmp-каталоги и открытые соединения этой сессии — очищаются в afterAll (§14). */
  const dirs: string[] = [];
  const opened: EncryptedDatabase[] = [];

  /** Путь шаблона v1 (создаётся в beforeAll, клонируется каждому тесту). */
  let templatePath = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-repo-int-'));
    dirs.push(dir);
    templatePath = join(dir, 'template.sqlite');
    const db = openEncrypted(templatePath, TEST_KEY_HEX);
    opened.push(db);
    // Реальный путь приложения (§19): openEncrypted → MigrationRunner с MIGRATIONS.
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
    db.close();
  });

  afterAll(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // уже закрыт (тест персистентности закрывает сам) — не важно для очистки
      }
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Клон шаблона: свежая v1-БД (data_version='1', bp_measurement пуст) + сид
   * профилей 'profile-1'/'profile-2'. Профили нужны: v1 имеет FK на profile(id)
   * при foreign_keys=ON (TASK-022 §8), а контрактный набор пишет именно эти
   * profileId — подготовка окружения, не трогая сам контракт (TASK-021 §3).
   */
  const cloneTemplate = (name: string): { db: EncryptedDatabase; path: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-repo-int-'));
    dirs.push(dir);
    const path = join(dir, name);
    copyFileSync(templatePath, path);
    const db = openEncrypted(path, TEST_KEY_HEX);
    opened.push(db);
    db.prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0), ('profile-2', 'Тест 2', 0)",
    ).run();
    return { db, path };
  };

  /** Фабрика контракта (§19): свежий клон на каждый тест — состояние изолировано. */
  const makeRepository: RepositoryFactory = () =>
    new SqliteBpMeasurementRepository(cloneTemplate('contract.sqlite').db);

  // Контрактный набор TASK-021 (группы 1–7 + 8 countByPeriod TASK-030) — на
  // SQLite-реализации (§19/§20 п. 1).
  runRepositoryContract(makeRepository);

  describe('8. fail-point: сбой после первого statement → полный rollback (§13/§19.8/§20)', () => {
    it('add с инъекцией сбоя: ни записи, ни bump data_version (§19.8)', async () => {
      const { db } = cloneTemplate('failpoint.sqlite');
      const repo = new SqliteBpMeasurementRepository(db, {
        failAfterFirstStatementForTesting: true,
      });
      const m = seed({ takenAtUtcMs: BASE_MS, pulse: 70, note: 'до сбоя' });

      const result = await repo.add(m);

      // Сбой — не SQL-ошибка → STORAGE/FAILED (§9: остальное); наружу только код.
      expect(result.ok).toBe(false);
      expect(errOf(result).code).toBe('STORAGE/FAILED');
      // Полный rollback: записи нет, версия не сдвинулась (§13).
      expect(await repo.getById(m.id)).toBeUndefined();
      expect(await repo.currentDataVersion()).toBe(1);
      // Таблица физически пуста (rollback, а не «запись без версии»).
      expect(
        (db.prepare('SELECT count(*) AS n FROM bp_measurement').get() as { n: number }).n,
      ).toBe(0);
    });

    it('после сбоя БД рабоча: адаптер без fail-point на том же соединении пишет успешно (§13)', async () => {
      const { db } = cloneTemplate('failpoint-reuse.sqlite');
      const failing = new SqliteBpMeasurementRepository(db, {
        failAfterFirstStatementForTesting: true,
      });
      const m = seed({ takenAtUtcMs: BASE_MS });
      await failing.add(m);

      const working = new SqliteBpMeasurementRepository(db);
      expect((await working.add(m)).ok).toBe(true);
      expect(await working.getById(m.id)).toEqual(m);
      // Версия сдвинулась ровно на одну успешную мутацию: 1 → 2 (§13).
      expect(await working.currentDataVersion()).toBe(2);
    });
  });

  describe('9. roundtrip всех полей, включая юникод/эмодзи в note (§19.9/§20)', () => {
    it('pulse=NULL, irregular=true, note с юникодом и эмодзи — без искажений (§19.9)', async () => {
      const repo = makeRepository();
      const note = 'После бега 🏃 — ünïcødé ✓ 血压 «кавычки» \t таб';
      const m = seed({
        takenAtUtcMs: BASE_MS,
        sys: 128,
        dia: 82,
        irregularPulse: true,
        arm: 'right',
        note,
      });

      expect((await repo.add(m)).ok).toBe(true);
      const loaded = await repo.getById(m.id);

      expect(loaded).toEqual(m);
      expect(loaded?.note).toBe(note);
      expect(loaded?.note?.length).toBe(note.length);
      expect(loaded?.pulse).toBeUndefined();
      expect(loaded?.irregularPulse).toBe(true);
      expect(loaded?.takenAt).toEqual(at(BASE_MS));
    });
  });

  describe('ошибки ограничений БД → STORAGE/CONSTRAINT (§9/§20)', () => {
    it('add дубликата id → err STORAGE/CONSTRAINT, не throw (§20)', async () => {
      const repo = makeRepository();
      const m = seed({ takenAtUtcMs: BASE_MS });
      expect((await repo.add(m)).ok).toBe(true);

      const duplicate = await repo.add(m);
      expect(duplicate.ok).toBe(false);
      expect(errOf(duplicate).code).toBe('STORAGE/CONSTRAINT');
      // UNIQUE-причина видна в cause (память main, §14); наружу — только код.
      const cause = errOf(duplicate).cause as { code?: string };
      expect(cause.code?.startsWith('SQLITE_CONSTRAINT')).toBe(true);
    });

    it('add с несуществующим profileId → STORAGE/CONSTRAINT (FK, §9: UNIQUE/NOT NULL и пр.)', async () => {
      const repo = makeRepository();
      const m = seed({ profileId: 'нет-такого-профиля', takenAtUtcMs: BASE_MS });

      const result = await repo.add(m);
      expect(result.ok).toBe(false);
      expect(errOf(result).code).toBe('STORAGE/CONSTRAINT');
    });
  });

  describe('персистентность и скоуп профиля (§2/§14)', () => {
    it('мутации переживают close/reopen того же файла (смысл SQLite-адаптера, §2)', async () => {
      const { db, path } = cloneTemplate('persist.sqlite');
      const repo = new SqliteBpMeasurementRepository(db);
      const m = seed({ takenAtUtcMs: BASE_MS, sys: 131, dia: 84, pulse: 66 });
      await repo.add(m);

      db.close();

      const reopened = openEncrypted(path, TEST_KEY_HEX);
      const repo2 = new SqliteBpMeasurementRepository(reopened);
      expect(await repo2.getById(m.id)).toEqual(m);
      expect(await repo2.currentDataVersion()).toBe(2);
      reopened.close();
    });

    it('update с чужим profileId не трогает запись → MEASUREMENT/NOT_FOUND (§14 скоуп)', async () => {
      const repo = makeRepository();
      const m = seed({ profileId: 'profile-1', takenAtUtcMs: BASE_MS });
      await repo.add(m);

      // edit наследует profileId — подмена скоупа возможна только извне домена:
      // агрегат profile-2 с id записи profile-1 (нарушение инвариантов владельца).
      const foreign = unsafeUnwrap(
        BpMeasurement.create(
          {
            profileId: 'profile-2',
            sys: 120,
            dia: 80,
            irregularPulse: false,
            arm: 'left',
            takenAt: at(BASE_MS),
          },
          new FixedClock(NOW_MS, TZ),
        ),
      );
      // Тот же id, что у записи profile-1: редактируем «чужими руками» (§14).
      // id приватен для записи — подменяем через фабрику невозможным способом нельзя,
      // поэтому проверяем скоуп списком и тем, что чужой add не затёр запись.
      const spoofed = Object.create(foreign) as BpMeasurement;
      Object.defineProperty(spoofed, 'id', { value: m.id, enumerable: true });

      const result = await repo.update(spoofed);
      expect(result.ok).toBe(false);
      expect(errOf(result).code).toBe('MEASUREMENT/NOT_FOUND');
      // Запись profile-1 не изменилась.
      expect(await repo.getById(m.id)).toEqual(m);
      // Скоуп списком: profile-2 не видит запись profile-1 (арх. 08 §3).
      expect(await repo.listByPeriod({ profileId: 'profile-2' })).toEqual([]);
    });
  });

  describe('dev-контракт profileId (§14, паритет с fake — TASK-021 §20)', () => {
    it('listByPeriod без profileId → синхронный throw TypeError (§14)', () => {
      const repo = makeRepository();
      // Имитация JS-вызова без обязательного поля: тип нарушен умышленно (dev-контракт).
      const broken = {} as MeasurementQuery;
      expect(() => repo.listByPeriod(broken)).toThrow(TypeError);
    });

    it('listByPeriod с пустым profileId → throw TypeError (§14)', () => {
      const repo = makeRepository();
      expect(() => repo.listByPeriod({ profileId: '' })).toThrow(TypeError);
    });
  });
});
