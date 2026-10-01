// TASK-064 §19/§20: интеграционный roundtrip-тест use case ExportJson на tmp-БД —
// весь боевой путь чтения: SqliteBpMeasurementRepository → MeasurementDto (§7),
// SettingsStore (prefs, §5), ScaleService (активная шкала, §5) → ExportJsonUseCase →
// JSON.parse → JSON_SNAPSHOT_SCHEMA.parse (AC §20.1: «слепок из реальной tmp-БД
// проходит SnapshotSchema.parse»; §22 — schema-тест чтением реального экспорта).
//
// Покрывается:
//  - AC §20.1: слепок из реальной tmp-БД валиден собственной схемой (roundtrip);
//  - AC §20.2: counts = фактическим длинам массивов (deep-сверка, §9);
//  - AC §20.3: граничные поля без искажений — «null-пульс» (ключ отсутствует),
//    irregularPulse=true, эмодзи/перенос/«кавычки-ёлочки» в заметке;
//  - AC §20.4: formatVersion=1 в корне, appVersion присутствует;
//  - §19: deep-сверка counts и ПОЛНОЙ формы первой записи (asc, прецедент CSV §13);
//  - скоуп профиля (§14, паритет CSV): запись profile-2 НЕ попадает в слепок;
//  - §13: prefs не настроены → ключа prefs нет.
//
// Инфраструктура — прецедент reporting-export-csv.int.test.ts (TASK-063): шаблон
// v1–v4 (openEncrypted фиксированным hex-ключом → MigrationRunner с MIGRATIONS)
// создаётся один раз и клонируется копированием файла; tmp ОС, очистка в afterAll.
//
// РАСПОЛОЖЕНИЕ — src/main, не modules/reporting: тест сводит ТРИ модуля (measurement
// + settings-profile + analytics) и reporting, потому импортирует их внутренности
// напрямую — как container.int.test.ts и тесты хендлеров (depcruise module-public-api:
// файлам внутри modules/ чужой модуль доступен только через index.ts, составу src/main
// — напрямую). Адаптеры портов §8 собраны инлайн — боевая регистрация канала
// `report/export-json` и вынесение адаптеров в reporting/adapters — TASK-065 (§11).
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';
import { JSON_SNAPSHOT_SCHEMA, PREFS_SCHEMA } from '@hl/contracts';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
import { FixedClock, Instant, unsafeUnwrap } from '@hl/kernel';

import { SqliteScaleRepository } from './modules/analytics/adapters/sqlite-scale-repository.js';
import { ScaleService } from './modules/analytics/application/scale-service.js';
import { SqliteBpMeasurementRepository } from './modules/measurement/adapters/sqlite-measurement-repository.js';
import { toMeasurementDto } from './modules/measurement/application/add-measurement.js';
import { BpMeasurement } from './modules/measurement/domain/bp-measurement.js';
import { ExportJsonUseCase } from './modules/reporting/application/export-json.js';
import type {
  ExportJsonPrefsSource,
  ExportJsonScalesSource,
  ExportJsonSource,
} from './modules/reporting/application/export-json.js';
import { SettingsStore } from './modules/settings-profile/adapters/settings-store.js';
import { PREFS_STORAGE_KEY } from './modules/settings-profile/application/preferences-service.js';
import { MigrationRunner } from './shared/db/migration-runner.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';
import { openEncrypted, type EncryptedDatabase } from './shared/db/sqlite.js';

/** Фиксированный тестовый ключ (прецедент TASK-026 §19): 32 байта hex. */
const TEST_KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» = 2026-09-25T16:00:00+03:00 — позже всех фикстурных takenAt. */
const NOW_MS = 1_790_341_200_000;
const TZ = 180;
const APP_VERSION = '1.2.3-test';

/** Момент из настенной строки со своим offset (EC-06): парсер ядра, без ручных мс. */
const at = (wallIso: string) => Instant.fromIso(wallIso);

/** utcMs фикстуры m1: 2026-09-20T07:45:00+03:00 (= 04:45:00Z, для deep-сверки первой записи). */
const M1_UTC_MS = 1_789_879_500_000;

/** Спецификация сид-записи. */
interface SeedSpec {
  readonly profileId?: string;
  readonly takenAt: string;
  readonly sys: number;
  readonly dia: number;
  readonly pulse?: number;
  readonly irregularPulse?: boolean;
  readonly arm: 'left' | 'right';
  readonly note?: string;
}

/** Фикстуры журнала (сид в НЕхронологическом порядке добавления; asc — работа экспорта, §13). */
const SEED: { m1: SeedSpec; m2: SeedSpec; m3: SeedSpec; alien: SeedSpec } = {
  // m1 — граничная запись AC §20.3: «null-пульс» + irregularPulse=true, без заметки.
  m1: {
    takenAt: '2026-09-20T07:45:00.000+03:00',
    sys: 118,
    dia: 76,
    pulse: undefined,
    irregularPulse: true,
    arm: 'right',
    note: undefined,
  },
  // m2 — перенос строки + эмодзи в заметке.
  m2: {
    takenAt: '2026-09-22T21:30:00.000+03:00',
    sys: 135,
    dia: 85,
    pulse: 88,
    arm: 'left',
    note: 'вечерний замер\nпосле тренировки 💪',
  },
  // m3 — эмодзи, «;» и «кавычки-ёлочки».
  m3: {
    takenAt: '2026-09-24T08:12:00.000+03:00',
    sys: 128,
    dia: 82,
    pulse: 76,
    arm: 'left',
    note: '😊 эмодзи; «кавычки-ёлочки»',
  },
  // Чужой профиль: НЕ должен попасть в слепок profile-1 (§14 скоуп).
  alien: {
    profileId: 'profile-2',
    takenAt: '2026-09-22T10:00:00.000+03:00',
    sys: 150,
    dia: 95,
    pulse: 90,
    arm: 'left',
  },
};

describe('ExportJsonUseCase: roundtrip-слепок на tmp-БД (TASK-064 §19/§20)', () => {
  /** tmp-каталоги и открытые соединения сессии — очистка в afterAll (§14). */
  const dirs: string[] = [];
  const opened: EncryptedDatabase[] = [];

  let templatePath = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-export-json-int-'));
    dirs.push(dir);
    templatePath = join(dir, 'template.sqlite');
    const db = openEncrypted(templatePath, TEST_KEY_HEX);
    opened.push(db);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
    db.close();
  });

  afterAll(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // уже закрыт — не важно для очистки
      }
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Свежий клон шаблона + сид: профили (FK v1 при foreign_keys=ON, TASK-022 §8),
   * три записи профиля-1 (включая граничные поля AC §20.3) и одна чужая (профиль-2).
   * Возвращает use case с БОЕВЫМИ источниками (SQLite-репозиторий журнала,
   * SettingsStore — §5 «prefs из SettingsStore», ScaleService — §5), id созданных
   * записей m1/m2/m3 и сохранён ли документ prefs.
   */
  const makeFixture = async (options: {
    seedPrefs: boolean;
  }): Promise<{ useCase: ExportJsonUseCase; m1Id: string; m2Id: string; m3Id: string }> => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-export-json-int-'));
    dirs.push(dir);
    const path = join(dir, 'export.sqlite');
    copyFileSync(templatePath, path);
    const db = openEncrypted(path, TEST_KEY_HEX);
    opened.push(db);
    db.prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0), ('profile-2', 'Тест 2', 0)",
    ).run();

    const clock = new FixedClock(NOW_MS, TZ);
    const repo = new SqliteBpMeasurementRepository(db);
    const create = (spec: SeedSpec): BpMeasurement =>
      unsafeUnwrap(
        BpMeasurement.create(
          {
            profileId: spec.profileId ?? 'profile-1',
            sys: spec.sys,
            dia: spec.dia,
            pulse: spec.pulse,
            irregularPulse: spec.irregularPulse ?? false,
            arm: spec.arm,
            note: spec.note,
            takenAt: at(spec.takenAt),
          },
          clock,
        ),
      );
    const m1 = create(SEED.m1);
    const m2 = create(SEED.m2);
    const m3 = create(SEED.m3);
    unsafeUnwrap(await repo.add(m1));
    unsafeUnwrap(await repo.add(m2));
    unsafeUnwrap(await repo.add(m3));
    unsafeUnwrap(await repo.add(create(SEED.alien)));

    // prefs (§5): SettingsStore — боевой адаптер; частичный документ → zod-дефолты.
    const settingsStore = new SettingsStore(db, { clock });
    if (options.seedPrefs) {
      await settingsStore.set(
        PREFS_STORAGE_KEY,
        JSON.stringify({ theme: 'dark', textScale: '112.5' }),
      );
    }

    // Активная шкала (§5): боевой ScaleService над reference_scale v4.
    const scaleService = new ScaleService({
      repo: new SqliteScaleRepository(db, { clock }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      data: BP_OFFICE_ESC2018,
    });
    await scaleService.ensureActivated();

    // Порты §8 над боевой инфраструктурой (профиль — чтение таблицы v1 напрямую).
    const profileStmt = db.prepare<[string], { id: string; name: string; created_at_utc: number }>(
      'SELECT id, name, created_at_utc FROM profile WHERE id = ?',
    );
    const source: ExportJsonSource = {
      getProfile: (profileId) =>
        Promise.resolve(
          (() => {
            const row = profileStmt.get(profileId);
            return row === undefined
              ? undefined
              : { id: row.id, name: row.name, createdAtUtc: row.created_at_utc };
          })(),
        ),
      listMeasurements: (profileId) =>
        repo.listByPeriod({ profileId }).then((items) => items.map(toMeasurementDto)),
    };
    const prefsSource: ExportJsonPrefsSource = {
      getPrefs: () => Promise.resolve(settingsStore.get(PREFS_STORAGE_KEY, PREFS_SCHEMA)),
    };
    const scalesSource: ExportJsonScalesSource = {
      listActiveScales: () =>
        scaleService
          .getActiveScale()
          .then((scale) => [{ code: scale.code, version: scale.version }]),
    };

    return {
      useCase: new ExportJsonUseCase({
        source,
        prefs: prefsSource,
        scales: scalesSource,
        clock,
        appVersion: APP_VERSION,
        logger: { debug: () => {}, info: () => {}, error: () => {} },
      }),
      m1Id: m1.id,
      m2Id: m2.id,
      m3Id: m3.id,
    };
  };

  it('AC1/AC2/AC4: слепок 3 записей + prefs + шкала проходит JSON_SNAPSHOT_SCHEMA.parse; counts = длинам массивов; formatVersion=1, appVersion есть', async () => {
    const { useCase } = await makeFixture({ seedPrefs: true });

    const result = await useCase.execute('profile-1');
    const { json, count } = unsafeUnwrap(result);

    expect(count).toBe(3);
    // AC §20.1 (roundtrip): реальный экспорт валиден собственной схемой (§22 —
    // schema-тест чтением реального экспорта, прецедент TASK-054).
    const snapshot = JSON_SNAPSHOT_SCHEMA.parse(JSON.parse(json));

    // AC §20.4: formatVersion=1 в корне; appVersion присутствует.
    expect(snapshot.formatVersion).toBe(1);
    expect(snapshot.appVersion).toBe(APP_VERSION);

    // AC §20.2 (counts из фактов, §9): счётчики равны фактическим длинам массивов.
    expect(snapshot.counts).toEqual({ measurements: 3, profiles: 1 });
    expect(snapshot.counts.measurements).toBe(snapshot.measurements.length);
    expect(snapshot.counts.profiles).toBe(snapshot.profiles.length);

    // Профиль (§5): факты хранилища (сид created_at_utc=0 — валидно для v1).
    expect(snapshot.profiles).toEqual([{ id: 'profile-1', name: 'Тест', createdAtUtc: 0 }]);

    // Активная шкала — только код/версия (§7).
    expect(snapshot.scales).toEqual([{ code: 'bp_office_esc2018', version: '1.0.0' }]);

    // prefs (§5): сохранённый частичный документ + zod-дефолты PREFS_SCHEMA
    // (TASK-074: jobState; TASK-075: netConsents.modelsDownload; TASK-081/088:
    // aiSettings — дефолт схемы, включая includeNotes; TASK-094: autoLockMin).
    expect(snapshot.prefs).toEqual({
      theme: 'dark',
      textScale: '112.5',
      dateFormat: 'auto',
      advancedMode: false,
      netConsents: { updatesCheck: false, modelsDownload: false },
      jobState: { jobs: {}, shown: {} },
      aiSettings: { dismissed: false, includeNotes: false },
      autoLockMin: 5,
    });

    // Скоуп профиля (§14, паритет CSV): чужая запись не просочилась.
    expect(json).not.toContain('profile-2');
  });

  it('§19/AC3: deep-сверка полной формы первой записи (asc); граничные поля без искажений', async () => {
    const { useCase, m1Id, m2Id, m3Id } = await makeFixture({ seedPrefs: true });

    const { json } = unsafeUnwrap(await useCase.execute('profile-1'));
    const snapshot = JSON_SNAPSHOT_SCHEMA.parse(JSON.parse(json));

    // Хронология asc (§13, паритет CSV): первая запись — самая старая (m1).
    expect(snapshot.measurements.map((m) => m.id)).toEqual([m1Id, m2Id, m3Id]);

    // §19: deep-сверка ПОЛНОЙ формы первой записи — каждый ключ DTO TASK-028.
    const first: MeasurementDto = snapshot.measurements[0]!;
    expect(first).toEqual({
      id: m1Id,
      profileId: 'profile-1',
      sys: 118,
      dia: 76,
      // «Пульс не измерен» = ключ pulse ОТСУТСТВУЕТ (JSON не знает undefined) —
      // «null-пульс» без искажений, та же конвенция, что у канала list (TASK-028).
      irregularPulse: true,
      arm: 'right',
      takenAtUtcMs: M1_UTC_MS,
      tzOffsetMin: 180,
      source: 'manual',
      createdAtUtcMs: NOW_MS,
      updatedAtUtcMs: NOW_MS,
    } satisfies Partial<MeasurementDto>);
    expect(Object.hasOwn(first, 'pulse')).toBe(false);
    expect(Object.hasOwn(first, 'note')).toBe(false);

    // AC §20.3: эмодзи/перенос/«кавычки-ёлочки» в заметках — без искажений.
    expect(snapshot.measurements[1]?.note).toBe('вечерний замер\nпосле тренировки 💪');
    expect(snapshot.measurements[2]?.note).toBe('😊 эмодзи; «кавычки-ёлочки»');
    // Эмодзи в самом JSON — литералом (читаемо в редакторе, §24), не \u-эскейпом.
    expect(json).toContain('💪');
    expect(json).toContain('😊');
  });

  it('§13: prefs не настроены → ключа prefs нет в корне (слепок валиден схемой)', async () => {
    const { useCase } = await makeFixture({ seedPrefs: false });

    const { json } = unsafeUnwrap(await useCase.execute('profile-1'));

    const snapshot = JSON_SNAPSHOT_SCHEMA.parse(JSON.parse(json));
    expect(Object.hasOwn(snapshot, 'prefs')).toBe(false);
    // Остальной состав не пострадал: замеры и шкала на месте.
    expect(snapshot.measurements).toHaveLength(3);
    expect(snapshot.scales).toEqual([{ code: 'bp_office_esc2018', version: '1.0.0' }]);
  });
});
