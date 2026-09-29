/**
 * TASK-068 §20-1/§24 (приёмка): генератор golden-файла для РУЧНОЙ PDF-проверки —
 * «открыть сгенерированный отчёт в системном просмотрщике: шрифты/вёрстка/читаемость,
 * состав соответствует чек-листу». Среды CI/агента без GUI сам шаг выполнить не
 * может — утилита делает его воспроизводимой одной командой:
 * `pnpm export:golden-pdf [--out <path>]`.
 *
 * Файл создаётся ПОЛНЫМ боевым путём приложения (то, что собирает сам health-log):
 * tmp-v1-БД (openEncrypted фиксированным тестовым ключом → MigrationRunner с
 * MIGRATIONS → SqliteBpMeasurementRepository, как в export-golden-csv.mjs) →
 * 60 записей за 30 дней через repo.add (утро/вечер, кириллица, многострочная
 * заметка, «кавычки-ёлочки», пропущенный пульс, нерегулярный пульс, повышенные
 * значения) → BuildPdfReportUseCase на боевых адаптерах точек/статистики и БОЕВОМ
 * WorkerPool с задачей pdf.render из TASK-067 — та же матрица, что в
 * apps/desktop/src/main/reporting-pdf-smoke.int.test.ts. Контейнер целиком не
 * собирается: его граф тянет IPC-регистрацию со статическим import('electron')
 * (в node-окружении вне vitest-алиаса это падает) — здесь собираются только части,
 * нужные UC-05: БД+репозиторий, FileOpQueue (боевая общая очередь записи) и
 * WorkerPool с дефолтным tasksModule reporting. Единственная подстановка — saver:
 * save-диалог Electron в node-окружении недоступен (§22 065), байты воркера пишутся
 * прямо в целевой файл.
 *
 * ВЫВОД ПО УМОЛЧАНИЮ: tools/export-samples/TASK-068-golden.pdf (в .gitignore —
 * артефакт ручной проверки).
 *
 * Импорты — ОТНОСИТЕЛЬНЫЕ к исходникам (прецедент export-golden-csv.mjs): у корня
 * монорепо нет зависимости @hl/kernel (pnpm-воркспейс линкует пакеты в
 * apps/desktop/node_modules), резолв идёт вверх от импортируемого файла.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { AppError, FixedClock } from '../../packages/kernel/src/index.js';

import { BpMeasurement } from '../../apps/desktop/src/main/modules/measurement/domain/bp-measurement.js';
import { SqliteBpMeasurementRepository } from '../../apps/desktop/src/main/modules/measurement/adapters/sqlite-measurement-repository.js';
import { assessCritical } from '../../apps/desktop/src/main/modules/measurement/index.js';
import { FileOpQueue } from '../../apps/desktop/src/main/modules/data-care/application/file-op-queue.js';
import { BuildPdfReportUseCase } from '../../apps/desktop/src/main/modules/reporting/application/build-pdf-report.js';
import { ReportPointsAdapter } from '../../apps/desktop/src/main/modules/reporting/adapters/report-points-adapter.js';
import { ReportStatsAdapter } from '../../apps/desktop/src/main/modules/reporting/adapters/report-stats-adapter.js';
import { PDF_TASKS_MODULE_URL } from '../../apps/desktop/src/main/modules/reporting/adapters/pdf/pdf-tasks-url.js';
import { MigrationRunner } from '../../apps/desktop/src/main/shared/db/migration-runner.js';
import { MIGRATIONS } from '../../apps/desktop/src/main/shared/db/migrations/index.js';
import { openEncrypted } from '../../apps/desktop/src/main/shared/db/sqlite.js';
import { WorkerPool } from '../../apps/desktop/src/main/shared/workerpool/pool.js';

/** Корень монорепо (tools/scripts/*.mjs → ../../). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Фиксированный тестовый ключ (та же схема, что в интеграционных тестах TASK-026). */
const TEST_KEY_HEX = 'ab'.repeat(32);

/** «Сейчас»: 2025-09-26T10:00+03:00 — позже всех сид-записей. */
const NOW_MS = 1_758_870_000_000;
const TZ = 180;
const PROFILE = 'profile-1';
const DAYS = 30;

/** Утро/вечер опорного дня (2025-08-26, +03:00); день d добавляется умножением. */
const MORNING_BASE_MS = Date.parse('2025-08-26T08:15:00.000+03:00');
const EVENING_BASE_MS = Date.parse('2025-08-26T21:30:00.000+03:00');

/** Инъекционный Clock (структурная реализация ядра — §4 TASK-017). */
const clock = new FixedClock(NOW_MS, TZ);

/** Заглушка логгера (структурно HlLogger) — в файл не пишет. */
const silentLogger = { debug: () => undefined, info: () => undefined, error: () => undefined };

/** Извлекает значение ok-Result; err в тестовой утилите — падение с кодом. */
function unsafeUnwrap(result) {
  if (!result.ok) {
    const error = result.error;
    const cause = error.cause !== undefined ? `; cause: ${String(error.cause)}` : '';
    throw new Error(
      `golden-pdf: err ${error.code} (${error.messageKey})${cause}; props: ${Object.getOwnPropertyNames(error).join(', ')}`,
    );
  }
  return result.value;
}

/** Сид-значения утра/вечера дня d: волна давления + заведомо повышенный день. */
function bpFor(day, isMorning) {
  const wave = Math.round(12 * Math.sin(day / 4.5));
  if (day % 10 === 3) {
    return { sys: 168 + (day % 5), dia: 102 + (day % 4), pulse: 88 + (day % 6) };
  }
  return isMorning
    ? { sys: 124 + wave, dia: 80 + Math.round(wave / 2), pulse: 64 + (day % 9) }
    : { sys: 131 + wave, dia: 85 + Math.round(wave / 2), pulse: 72 + (day % 7) };
}

/** Заметки-маркеры рендера: кириллица, «кавычки», точка с запятой, перенос строки. */
function noteFor(day, isMorning) {
  if (day === 3 && isMorning) {
    return 'болит; голова "сильно"';
  }
  if (day === 7 && !isMorning) {
    return 'вечерний замер\nпосле тренировки';
  }
  if (day === 14 && isMorning) {
    return '«кавычки-ёлочки»; самочувствие нормальное';
  }
  if (day === 21 && isMorning) {
    return 'ок';
  }
  return undefined;
}

/** Сид записи дня d (утро/вечер) → агрегат через публичную фабрику create (TASK-017). */
function seedRecord(day, isMorning) {
  const { sys, dia, pulse } = bpFor(day, isMorning);
  return unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: PROFILE,
        sys,
        dia,
        // Вечер 7-го дня — пропущенный пульс (пустая ячейка в таблице).
        ...(day === 7 && !isMorning ? { pulse: undefined } : { pulse }),
        irregularPulse: day === 12 && !isMorning,
        arm: isMorning ? 'left' : 'right',
        note: noteFor(day, isMorning),
        takenAt: {
          utcMs: (isMorning ? MORNING_BASE_MS : EVENING_BASE_MS) + day * 86_400_000,
          tzOffsetMin: TZ,
        },
      },
      clock,
    ),
  );
}

/**
 * Генерирует golden-PDF полным боевым путём и пишет его в outPath.
 * Возвращает { outPath, count, pages, durationMs }.
 */
export async function run({ out } = {}) {
  const outPath = out ?? join(REPO_ROOT, 'tools', 'export-samples', 'TASK-068-golden.pdf');

  // 1. Шаблон v1 во временном каталоге ОС: «открыл → мигрировал», как в приложении.
  const dir = mkdtempSync(join(tmpdir(), 'hl-golden-pdf-'));
  const dbPath = join(dir, 'golden-pdf.sqlite');
  const pool = new WorkerPool({
    entryUrl: new URL('../../apps/desktop/src/main/shared/workerpool/worker.ts', import.meta.url),
    tasksModule: PDF_TASKS_MODULE_URL.href,
    logger: silentLogger,
  });
  let db;
  try {
    db = openEncrypted(dbPath, TEST_KEY_HEX);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
    // Профили — FK v1 при foreign_keys=ON (TASK-022 §8).
    db.prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0)",
    ).run();

    // 2. Сид: 60 записей за 30 дней (утро/вечер) через репозиторий — доменный путь записи.
    const repo = new SqliteBpMeasurementRepository(db);
    for (let day = 0; day < DAYS; day += 1) {
      try {
        unsafeUnwrap(await repo.add(seedRecord(day, true)));
        unsafeUnwrap(await repo.add(seedRecord(day, false)));
      } catch (error) {
        throw new Error(`день ${day}: ${error.message}`, { cause: error });
      }
    }

    // 3. Use case UC-05 на боевых частях: порты над SQLite-репозиторием,
    //    рендер — боевой WorkerPool (pdf.render в воркере), запись — общая очередь.
    const pointsPort = {
      listByPeriod: (query) =>
        repo.listByPeriod(query).then((measurements) =>
          measurements.map((m) => ({
            id: m.id,
            sys: m.bp.sys,
            dia: m.bp.dia,
            pulse: m.pulse,
            takenAt: m.takenAt,
            critical: assessCritical(m.bp.sys, m.bp.dia),
          })),
        ),
    };
    const useCase = new BuildPdfReportUseCase({
      points: new ReportPointsAdapter(repo),
      stats: new ReportStatsAdapter(pointsPort),
      pool: { run: (name, payload) => pool.run(name, payload) },
      saver: {
        saveCsv: () => Promise.reject(new Error('golden-pdf: saveCsv не вызывается')),
        saveJson: () => Promise.reject(new Error('golden-pdf: saveJson не вызывается')),
        savePdf: (_defaultName, pdf) =>
          Promise.resolve(writeFileSync(outPath, pdf)).then(() => ({ path: outPath })),
      },
      queue: new FileOpQueue(),
      clock,
      appVersion: '0.0.0',
      logger: silentLogger,
    });

    const result = await useCase.execute({
      profileId: PROFILE,
      period: { fromUtcMs: NOW_MS - 86_400_000 * 31, toUtcMs: NOW_MS },
      includeAiSection: false,
    });
    const value = unsafeUnwrap(result);
    if (!('path' in value.file)) {
      throw new Error('golden-pdf: сохранение вернуло canceled вместо файла');
    }
    return { outPath, count: DAYS * 2, pages: value.pages, durationMs: value.durationMs };
  } finally {
    await pool.terminate();
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

  mkdirSync(dirname(out ?? join(REPO_ROOT, 'tools', 'export-samples', 'x.pdf')), {
    recursive: true,
  });
  const { outPath, count, pages, durationMs } = await run({ out });

  const bytes = readFileSync(outPath);
  const head = bytes.subarray(0, 5).toString('latin1');
  const tail = bytes.subarray(bytes.length - 32).toString('latin1');
  if (head !== '%PDF-' || !tail.includes('%%EOF')) {
    throw new Error('golden-pdf: файл не похож на PDF (%PDF-/%%EOF не на месте)');
  }

  console.log(`TASK-068 golden PDF: ${outPath}`);
  console.log(
    `  записей: ${count}; страниц: ${pages}; рендер: ${durationMs} мс; размер: ${statSync(outPath).size} байт`,
  );
  console.log('  Ручная проверка §20-1/§24: откройте файл в просмотрщике PDF — шрифты/');
  console.log('  вёрстка/читаемость, состав: титул, таблица 60 записей, средние, график,');
  console.log('  регулярность. Подтвердите результат — задача будет смержена.');
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error('export-golden-pdf failed:', error);
    exit(1);
  });
}
