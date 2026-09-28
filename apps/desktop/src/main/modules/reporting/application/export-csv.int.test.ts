// TASK-063 §19/§20: интеграционный тест use case ExportCsv на tmp-БД — весь боевой
// путь (SqliteBpMeasurementRepository → MeasurementExportAdapter → ExportCsvUseCase),
// 5 записей профиля-1 → ТОЧНЫЙ CSV-текст (golden, §5/§20).
//
// Покрывается:
//  - AC §20: golden-заметка `болит; голова "сильно"` корректно закавычена; BOM;
//    разделитель `;`; порядок takenAt asc (сид в НЕхронологическом порядке);
//  - эмодзи/юникод/перенос в заметке без искажений (текст сравнивается точно, §20);
//  - datetime — ISO со СВОИМ offset записи (EC-06) в формате примера §5 (без мс);
//  - опционалы: pulse не измерен → пустая ячейка; note без значения → пустая ячейка;
//  - скоуп профиля (§14): запись профиля-2 НЕ попадает в выгрузку профиля-1;
//  - пустой журнал на реальной БД → валидный CSV с заголовком (§9/§20).
//
// Инфраструктура — прецедент sqlite-measurement-repository.int.test.ts (TASK-026):
// шаблон v1 (openEncrypted фиксированным hex-ключом → MigrationRunner с MIGRATIONS)
// создаётся один раз и клонируется копированием файла; tmp ОС, очистка в afterAll.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Instant, unsafeUnwrap } from '@hl/kernel';

import { SqliteBpMeasurementRepository } from '../../measurement/adapters/sqlite-measurement-repository.js';
import { BpMeasurement } from '../../measurement/domain/bp-measurement.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MeasurementExportAdapter } from '../adapters/measurement-export-adapter.js';
import { ExportCsvUseCase } from './export-csv.js';

/** Фиксированный тестовый ключ (прецедент TASK-026 §19): 32 байта hex. */
const TEST_KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» = 2026-09-25T16:00:00+03:00 — позже всех фикстурных takenAt. */
const NOW_MS = 1_790_341_200_000;
const TZ = 180;

/** Момент из настенной строки со своим offset (EC-06): парсер ядра, без ручных мс. */
const at = (wallIso: string) => Instant.fromIso(wallIso);

/** Спецификация сид-записи (значения фикстур — см. матрицу в шапке). */
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

describe('ExportCsvUseCase: интеграция на tmp-БД (TASK-063 §19/§20)', () => {
  /** tmp-каталоги и открытые соединения сессии — очистка в afterAll (§14). */
  const dirs: string[] = [];
  const opened: EncryptedDatabase[] = [];

  let templatePath = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-export-csv-int-'));
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

  /** Свежий клон шаблона v1 + сид профилей (FK v1 при foreign_keys=ON, TASK-022 §8). */
  const makeRepo = (): SqliteBpMeasurementRepository => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-export-csv-int-'));
    dirs.push(dir);
    const path = join(dir, 'export.sqlite');
    copyFileSync(templatePath, path);
    const db = openEncrypted(path, TEST_KEY_HEX);
    opened.push(db);
    db.prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0), ('profile-2', 'Тест 2', 0)",
    ).run();
    return new SqliteBpMeasurementRepository(db);
  };

  it('5 записей → точный CSV-текст: BOM, «;», asc, кавычки §20, эмодзи/перенос, скоуп профиля', async () => {
    const repo = makeRepo();
    const clock = new FixedClock(NOW_MS, TZ);
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
    const add = async (m: BpMeasurement): Promise<void> => {
      unsafeUnwrap(await repo.add(m));
    };

    // Сид в НЕхронологическом порядке (asc-сортировка — работа экспорта, §13).
    const m1 = create({
      takenAt: '2026-09-24T08:12:00.000+03:00',
      sys: 128,
      dia: 82,
      pulse: 76,
      arm: 'left',
      note: 'болит; голова "сильно"', // §20 golden: `;` и кавычки
    });
    const m2 = create({
      takenAt: '2026-09-20T07:45:00.000+03:00',
      sys: 118,
      dia: 76,
      pulse: undefined, // пульс не измерен → пустая ячейка
      irregularPulse: true,
      arm: 'right',
      note: undefined, // без заметки → пустая ячейка
    });
    const m3 = create({
      takenAt: '2026-09-22T21:30:00.000+03:00',
      sys: 135,
      dia: 85,
      pulse: 88,
      arm: 'left',
      note: 'вечерний замер\nпосле тренировки 💪', // перенос внутри кавычек + эмодзи
    });
    const m5 = create({
      takenAt: '2026-09-23T07:58:00.000+03:00',
      sys: 125,
      dia: 84,
      pulse: 82,
      irregularPulse: true,
      arm: 'left',
      note: '😊 эмодзи и юникод; «кавычки-ёлочки»',
    });
    const m4 = create({
      takenAt: '2026-09-21T09:05:00.000+03:00',
      sys: 122,
      dia: 79,
      pulse: 70,
      arm: 'left',
      note: 'ок',
    });
    // Чужой профиль: НЕ должен попасть в выгрузку profile-1 (§14 скоуп).
    create({
      profileId: 'profile-2',
      takenAt: '2026-09-22T10:00:00.000+03:00',
      sys: 150,
      dia: 95,
      pulse: 90,
      arm: 'left',
    });

    await add(m1);
    await add(m2);
    await add(m3);
    await add(m5);
    await add(m4);

    const useCase = new ExportCsvUseCase({
      source: new MeasurementExportAdapter(repo),
      logger: { debug: () => {}, info: () => {}, error: () => {} },
    });

    const result = await useCase.execute('profile-1');
    const { csv, count } = unsafeUnwrap(result);

    expect(count).toBe(5);
    expect(csv).toBe(
      [
        '\uFEFFid;profileId;datetime;sys;dia;pulse;irregular;arm;note;source',
        `${m2.id};profile-1;2026-09-20T07:45:00+03:00;118;76;;true;right;;manual`,
        `${m4.id};profile-1;2026-09-21T09:05:00+03:00;122;79;70;false;left;ок;manual`,
        `${m3.id};profile-1;2026-09-22T21:30:00+03:00;135;85;88;false;left;"вечерний замер\nпосле тренировки 💪";manual`,
        `${m5.id};profile-1;2026-09-23T07:58:00+03:00;125;84;82;true;left;"😊 эмодзи и юникод; «кавычки-ёлочки»";manual`,
        `${m1.id};profile-1;2026-09-24T08:12:00+03:00;128;82;76;false;left;"болит; голова ""сильно""";manual`,
      ].join('\r\n'),
    );
    // Скоуп (§14): чужой профиль не просочился.
    expect(csv).not.toContain('profile-2');
  });

  it('пустой журнал на реальной БД → валидный CSV: только BOM + заголовок (§9/§20)', async () => {
    const repo = makeRepo();
    const useCase = new ExportCsvUseCase({
      source: new MeasurementExportAdapter(repo),
      logger: { debug: () => {}, info: () => {}, error: () => {} },
    });

    const result = await useCase.execute('profile-1');
    const { csv, count } = unsafeUnwrap(result);

    expect(count).toBe(0);
    expect(csv).toBe('\uFEFFid;profileId;datetime;sys;dia;pulse;irregular;arm;note;source');
  });
});
