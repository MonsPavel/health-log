/**
 * TASK-063 §20.1/§24 (приёмка): генератор golden-файла для РУЧНОЙ Excel-проверки —
 * «открыть сгенерированный файл в Excel — колонки/кириллица/переносы корректны»,
 * скриншот в PR. Среды CI/агента без GUI сам шаг выполнить не может — утилита делает
 * его воспроизводимым одной командой: `pnpm export:golden-csv [--out <path>]`.
 *
 * Файл создаётся ПОЛНЫМ боевым путём приложения (то, что экспортирует сам health-log):
 * tmp-v1-БД (openEncrypted фиксированным тестовым ключом → MigrationRunner с
 * MIGRATIONS) → SqliteBpMeasurementRepository → MeasurementExportAdapter →
 * ExportCsvUseCase — на той же матрице фикстур, что
 * apps/desktop/src/main/reporting-export-csv.int.test.ts (золотая заметка
 * `болит; голова "сильно"`, перенос в заметке, эмодзи/юникод, пустые ячейки
 * pulse/note, чужой профиль для проверки скоупа). Вывод детерминирован кроме id
 * (uuid v7 доменной фабрики) — для ручной проверки это не важно.
 *
 * ВЫВОД ПО УМОЛЧАНИЮ: tools/export-samples/TASK-063-golden.csv (в .gitignore —
 * артефакт ручной проверки, как tools/bench-results/ у TASK-062).
 *
 * Тест-файл: export-golden-csv.test.mjs (tools-scripts, прогон `pnpm test`).
 *
 * Импорты — ОТНОСИТЕЛЬНЫЕ к исходникам apps/desktop: у корня монорепо нет
 * зависимости @hl/kernel (pnpm-воркспейс линкует пакеты в apps/desktop/node_modules),
 * резолв идёт вверх от импортируемого файла; Instant/FixedClock не нужны — Instant
 * структурный ({utcMs, tzOffsetMin}), Clock подставляется локальным стабом.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { BpMeasurement } from '../../apps/desktop/src/main/modules/measurement/domain/bp-measurement.js';
import { SqliteBpMeasurementRepository } from '../../apps/desktop/src/main/modules/measurement/adapters/sqlite-measurement-repository.js';
import { MeasurementExportAdapter } from '../../apps/desktop/src/main/modules/reporting/adapters/measurement-export-adapter.js';
import { ExportCsvUseCase } from '../../apps/desktop/src/main/modules/reporting/application/export-csv.js';
import { MigrationRunner } from '../../apps/desktop/src/main/shared/db/migration-runner.js';
import { MIGRATIONS } from '../../apps/desktop/src/main/shared/db/migrations/index.js';
import { openEncrypted } from '../../apps/desktop/src/main/shared/db/sqlite.js';

/** Корень монорепо (tools/scripts/*.mjs → ../../). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Фиксированный тестовый ключ (та же схема, что в интеграционных тестах TASK-026). */
const TEST_KEY_HEX = 'ab'.repeat(32);

/** «Сейчас» для домена: 2026-09-25T16:00:00+03:00 — позже всех фикстурных takenAt. */
const NOW_MS = 1_790_341_200_000;
const TZ = 180;

/** Инъекционный Clock (структурная реализация ядра — §4 TASK-017). */
const clock = { nowMs: () => NOW_MS, tzOffsetMin: () => TZ };

/** Момент из настенной строки со своим offset (EC-06): Date.parse понимает «±HH:MM». */
const at = (wallIso) => ({ utcMs: Date.parse(wallIso), tzOffsetMin: TZ });

/** Извлекает значение ok-Result; err в тестовой утилите — падение с кодом. */
function unsafeUnwrap(result) {
  if (!result.ok) {
    throw new Error(`golden-export: err ${result.error.code} (${result.error.messageKey})`);
  }
  return result.value;
}

/**
 * Спецификация сид-записи → агрегат через публичную фабрику create (домен — чёрный
 * ящик, единственный путь создания, TASK-017).
 */
function seed(repo, spec) {
  const created = BpMeasurement.create(
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
  );
  return unsafeUnwrap(created);
}

/**
 * Генерирует golden-CSV полным боевым путём и пишет его в outPath (UTF-8, BOM —
 * часть строки от toCsv). Возвращает { outPath, count, csv }.
 */
export async function run({ out } = {}) {
  const outPath = out ?? join(REPO_ROOT, 'tools', 'export-samples', 'TASK-063-golden.csv');

  // 1. Шаблон v1 во временном каталоге ОС: «открыл → мигрировал», как в приложении.
  const dir = mkdtempSync(join(tmpdir(), 'hl-golden-export-'));
  const dbPath = join(dir, 'golden-export.sqlite');
  let db;
  try {
    db = openEncrypted(dbPath, TEST_KEY_HEX);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
    // Профили — FK v1 при foreign_keys=ON (TASK-022 §8).
    db.prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0), ('profile-2', 'Тест 2', 0)",
    ).run();

    // 2. Сид матрицы §20/§24 — в НЕхронологическом порядке (asc — работа экспорта).
    const repo = new SqliteBpMeasurementRepository(db);
    const records = [
      seed(repo, {
        takenAt: '2026-09-24T08:12:00.000+03:00',
        sys: 128,
        dia: 82,
        pulse: 76,
        arm: 'left',
        note: 'болит; голова "сильно"',
      }),
      seed(repo, {
        takenAt: '2026-09-20T07:45:00.000+03:00',
        sys: 118,
        dia: 76,
        pulse: undefined,
        irregularPulse: true,
        arm: 'right',
      }),
      seed(repo, {
        takenAt: '2026-09-22T21:30:00.000+03:00',
        sys: 135,
        dia: 85,
        pulse: 88,
        arm: 'left',
        note: 'вечерний замер\nпосле тренировки 💪',
      }),
      seed(repo, {
        takenAt: '2026-09-23T07:58:00.000+03:00',
        sys: 125,
        dia: 84,
        pulse: 82,
        irregularPulse: true,
        arm: 'left',
        note: '😊 эмодзи и юникод; «кавычки-ёлочки»',
      }),
      seed(repo, {
        takenAt: '2026-09-21T09:05:00.000+03:00',
        sys: 122,
        dia: 79,
        pulse: 70,
        arm: 'left',
        note: 'ок',
      }),
      // Чужой профиль — не должен попасть в выгрузку profile-1 (§14 скоуп).
      seed(repo, {
        profileId: 'profile-2',
        takenAt: '2026-09-22T10:00:00.000+03:00',
        sys: 150,
        dia: 95,
        pulse: 90,
        arm: 'left',
      }),
    ];
    for (const record of records) {
      unsafeUnwrap(await repo.add(record));
    }

    // 3. Полный боевой путь экспорта (репозиторий → адаптер → use case).
    const useCase = new ExportCsvUseCase({
      source: new MeasurementExportAdapter(repo),
      logger: { debug: () => {}, info: () => {}, error: () => {} },
    });
    const { csv, count } = unsafeUnwrap(await useCase.execute('profile-1'));

    // 4. Файл на диск (UTF-8: ведущий \uFEFF строки → байты EF BB BF).
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, csv, 'utf8');

    return { outPath, count, csv };
  } finally {
    if (db !== undefined) {
      db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** CLI-обёртка: только при запуске как скрипта (импорт из теста вывода не пишет). */
async function main() {
  const outIndex = argv.indexOf('--out');
  const out = outIndex !== -1 ? argv[outIndex + 1] : undefined;

  const { outPath, count } = await run({ out });
  const bytes = (await import('node:fs')).readFileSync(outPath);
  const bomHex = [...bytes.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ');

  console.log(`TASK-063 golden CSV: ${outPath}`);
  console.log(`  записей: ${count}; размер: ${bytes.length} байт; первые байты: ${bomHex} (BOM)`);
  console.log('  Ручная проверка §24: откройте файл в Excel — колонки/кириллица/переносы');
  console.log('  корректны; приложите скриншот к PR (критерий §20.1).');
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error('export-golden-csv failed:', error);
    exit(1);
  });
}
