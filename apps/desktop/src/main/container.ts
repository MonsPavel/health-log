/**
 * TASK-027 §2/§5: composition root — ЕДИНСТВЕННОЕ место сборки графа зависимостей
 * приложения (ручной DI D13, арх. 03 §5): Clock → KeyVault → openEncrypted →
 * MigrationRunner → репозитории → EventBus → регистрация хендлеров IPC. Без
 * DI-фреймворка: граф мал и статичен; пересмотр при >10 модулей (арх. 03 §5).
 * Приложение стартует с реальной зашифрованной БД в userData.
 *
 * ПОРЯДОК ИНИЦИАЛИЗАЦИИ (§5): paths → logger (TASK-010) → vault.ensureKey →
 * openEncrypted(dbPath, keyHex) → Data Care/use case CreateBackup (TASK-070 — hook
 * миграций) → миграции → репозиторий → события; регистрация
 * существующих IPC-хендлеров — в конце buildContainer (§11), следом пул воркеров
 * CPU-задач (TASK-066, ленивый). Порядок полей Container — конвенция читаемости §7
 * (db, clock, vault, measurementRepo, events, logger); каналы каркаса и close
 * добавлены задачей 027, workerPool — 066, createBackup/fileOpQueue — 070 (см. Container).
 *
 * ТЕСТИРУЕМОСТЬ (§13/§19/§20 п. 4): контейнер не читает сам app.getPath — пути
 * вводятся параметрами (bootstrap подставляет реальные); время — порт Clock
 * (FixedClock в тестах); фабрика vault переопределяема (мок-vault без safeStorage) —
 * сборка идёт в node-окружении vitest, electron сюда НЕ импортируется статически:
 * боевой vault получает safeStorage ленивым `import('electron')` только в дефолтной
 * фабрике (вне Electron-рантайма — честная VAULT/UNAVAILABLE, §13 кейс 5).
 *
 * ОШИБКИ (§9/§13): init-ошибки пробрасываются выше bootstrap → глобальный хендлер
 * TASK-011 (диалог + код): отказ vault — AppError VAULT/*, отказ БД — STORAGE/* из
 * openEncrypted/runner. Отказ vault/БД → контейнер не создаётся (throw) — приложение
 * не в «полуживом» состоянии; открытый дескриптор БД закрывается до проброса
 * (Windows: файл остаётся заблокированным — прецедент openEncrypted TASK-022).
 *
 * БЕЗОПАСНОСТЬ (§14): keyHex живёт только в локальной области buildContainer —
 * полем Container не становится и наружу (renderer) не уходит; redact-списки
 * логгера (keyHex/key — TASK-010) страхуют нарушение правила вызова в глубине.
 *
 * ЛОГ (§18): «container ready» с фактами {db: basename, schemaVersion, keyCreated,
 * migrationsApplied} — ПОЛНЫЙ путь БД не логируется: userData содержит имя
 * Windows-пользователя, в лог идёт только basename файла.
 *
 * GRACEFUL SHUTDOWN (§8, включено в объём §5): close() — wal_checkpoint(TRUNCATE)
 * затем close() — чистое отсутствие -wal/-shm после выхода (NFR-2-гигиена);
 * bootstrap вызывает его на app 'will-quit'. TASK-066 §9: после закрытия БД —
 * terminate пула воркеров (активные задачи обрываются с логом: потерянный PDF при
 * закрытии приложения допустим; will-quit не висит).
 *
 * БУДУЩАЯ РАБОТА (§23): здесь же включатся use case'ы 029+ (место помечено —
 * секция «прикладные use case'ы» ниже), SettingsStore (047), ScaleService (051),
 * AI-модуль (076+), EgressGateway (075). Рост: при >15 зависимостях — деление на
 * per-module секции-фабрики (§22).
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import { AppError, SystemClock, type Clock } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';

import { createLogClientErrorHandler } from './app/global-errors.js';
import { EventBus } from './events/event-bus.js';
import { ElectronFileSaver } from './platform/file-saver.js';
import { BackupContainerCodec } from './modules/data-care/adapters/backup-container.js';
import { DialogFileSaver } from './modules/data-care/adapters/dialog-file-saver.js';
import {
  CreateBackupUseCase,
  createPreMigrationBackupHook,
} from './modules/data-care/application/create-backup.js';
import { FileOpQueue } from './modules/data-care/application/file-op-queue.js';
import {
  createAddMeasurementHandler,
  createListMeasurementHandler,
  createUpdateMeasurementHandler,
} from './ipc/handlers/measurements.js';
import { createDeleteMeasurementHandler } from './ipc/handlers/measurements-delete.js';
import { createPingHandler } from './ipc/handlers/ping.js';
import { createExportCsvHandler, createExportJsonHandler } from './ipc/handlers/report.js';
import { createBuildPdfReportHandler } from './ipc/handlers/report-pdf.js';
import { createRevealPathHandler } from './ipc/handlers/reveal.js';
import { createSearchNotesHandler } from './ipc/handlers/search.js';
import { createGetPrefsHandler, createSetPrefsHandler } from './ipc/handlers/prefs.js';
import { createGetActiveScaleHandler } from './ipc/handlers/scales.js';
import { createGetPeriodStatisticsHandler } from './ipc/handlers/stats.js';
import { createTrendSeriesHandler } from './ipc/handlers/trends.js';
import { createChannelRegistry, type ChannelRegistry } from './ipc/register-channel.js';
import { MeasurementPointsAdapter } from './modules/analytics/adapters/measurement-points-adapter.js';
import { SqliteScaleRepository } from './modules/analytics/adapters/sqlite-scale-repository.js';
import { GetPeriodStatistics } from './modules/analytics/application/get-period-statistics.js';
import { ScaleService } from './modules/analytics/application/scale-service.js';
import { TrendSeries } from './modules/analytics/application/trend-series.js';
// TASK-065 §5: экспорт CSV/JSON — use case'ы 063/064, адаптеры источников и
// оркестрация файловой записи (общая очередь fileOpQueue, §9).
import { MeasurementExportAdapter } from './modules/reporting/adapters/measurement-export-adapter.js';
import { JsonSnapshotSource } from './modules/reporting/adapters/json-snapshot-source.js';
import { ReportPointsAdapter } from './modules/reporting/adapters/report-points-adapter.js';
import { ReportStatsAdapter } from './modules/reporting/adapters/report-stats-adapter.js';
import { ExportCsvUseCase } from './modules/reporting/application/export-csv.js';
import { ExportCsvFileUseCase } from './modules/reporting/application/export-csv-file.js';
import { ExportJsonUseCase } from './modules/reporting/application/export-json.js';
import { ExportJsonFileUseCase } from './modules/reporting/application/export-json-file.js';
import { BuildPdfReportUseCase, type PdfRenderRunner } from './modules/reporting/application/build-pdf-report.js';
import type { PdfRenderResult } from './modules/reporting/application/report-spec.js';
// TASK-067 §9: дефолт tasksModule пула — модуль задач reporting (лёгкий файл URL:
// без импортов цепочки react-pdf — рендер живёт в воркере, не в графе main).
import { PDF_TASKS_MODULE_URL } from './modules/reporting/adapters/pdf/pdf-tasks-url.js';
import { SqliteBpMeasurementRepository } from './modules/measurement/adapters/sqlite-measurement-repository.js';
import { NotesSearchAdapter } from './modules/measurement/adapters/notes-search.js';
import { AddMeasurementUseCase } from './modules/measurement/application/add-measurement.js';
import { DeleteMeasurementUseCase } from './modules/measurement/application/delete-measurement.js';
import { ListMeasurementsUseCase } from './modules/measurement/application/list-measurements.js';
import type { BpMeasurementRepository } from './modules/measurement/application/ports/bp-measurement-repository.js';
import { SearchNotesUseCase } from './modules/measurement/application/search-notes.js';
import { UpdateMeasurementUseCase } from './modules/measurement/application/update-measurement.js';
import { SettingsStore } from './modules/settings-profile/adapters/settings-store.js';
import { PreferencesService } from './modules/settings-profile/application/preferences-service.js';
import {
  SafeStorageKeyVault,
  type VaultSafeStorage,
} from './modules/security/adapters/safe-storage-key-vault.js';
import type { VaultLogger } from './modules/security/adapters/safe-storage-key-vault.js';
import {
  VAULT_UNAVAILABLE_MESSAGE_KEY,
  type KeyVault,
} from './modules/security/application/ports/key-vault.js';
import { VAULT_KEY_FILENAME } from './shared/constants.js';
import { MigrationRunner } from './shared/db/migration-runner.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';
import { openEncrypted, type EncryptedDatabase } from './shared/db/sqlite.js';
import { createLogger, type HlLogger } from './shared/logger/logger.js';
import { WorkerPool, type WorkerPoolOptions } from './shared/workerpool/pool.js';
import { electronRevealPath } from './platform/reveal-path.js';

/** Имя файла БД в userData (§8): `<userData>/health-log.db` (+ `-wal`, `-shm`). */
export const DATABASE_FILENAME = 'health-log.db';

/** Каталог копий в userData (TASK-070 §7 — фикс): `<userData>/backups/`. */
export const BACKUPS_DIRNAME = 'backups';

/** Версия приложения по умолчанию (манифест копии, TASK-070 §2; bootstrap передаёт app.getVersion()). */
const DEFAULT_APP_VERSION = '0.0.0';

/**
 * Контекст сборки vault-а (§19: фабрика переопределяема): путь файла ключа контейнер
 * собирает сам (`<userData>/vault.key` — константа shared, TASK-023 §6), время и
 * логгер — те же порты, что и в остальном графе.
 */
export interface VaultFactoryContext {
  /** Полный путь файла хранилища ключа: `<userData>/vault.key`. */
  readonly vaultFilePath: string;
  /** Порт времени (createdUtc ключа); тот же экземпляр, что и в графе. */
  readonly clock: Clock;
  /** Логгер адаптера vault-а (§18): категория db. */
  readonly logger: VaultLogger;
}

/** Фабрика vault-а: точка подстановки мока в тестах (§19) и боевого адаптера. */
export type VaultFactory = (context: VaultFactoryContext) => KeyVault;

/** Зависимости сборки контейнера (§5: `{userDataPath, clock?, vault?}` — переопределяемо). */
export interface ContainerDeps {
  /** Каталог userData (§13: путь — параметр; bootstrap подставляет app.getPath). */
  readonly userDataPath: string;
  /** Порт времени; по умолчанию SystemClock (§19: FixedClock в тестах). */
  readonly clock?: Clock;
  /** Фабрика vault-а; по умолчанию — боевой SafeStorageKeyVault на safeStorage Electron. */
  readonly vault?: VaultFactory;
  /**
   * Опции пула воркеров (TASK-066 §5/§6); по умолчанию — боевые: entry worker.js из
   * dist, tasksModule — модуль задач reporting (pdf.render, TASK-067 §9). Тесты
   * подставляют entry/.tasksModule с тестовыми задачами (§19; прецедент
   * переопределяемых фабрик каркаса).
   */
  readonly workerPool?: WorkerPoolOptions;
  /**
   * Версия приложения (манифест копии, TASK-070 §2; титул отчёта). Bootstrap
   * передаёт app.getVersion(); по умолчанию — '0.0.0' (тесты/node-сборка).
   */
  readonly appVersion?: string;
}

/**
 * Собранный граф зависимостей (§7). Порядок полей = порядок инициализации (конвенция
 * §7); поля добавляются по мере задач (§23: use case'ы 029+, SettingsStore 047, …).
 */
export interface Container {
  /** Открытое зашифрованное БД-соединение, схема приведена к актуальной версии. */
  readonly db: EncryptedDatabase;
  /** Порт времени приложения (внедрён в ping-хендлер; SystemClock по умолчанию). */
  readonly clock: Clock;
  /** Хранилище ключа БД (боевой safeStorage-адаптер или подмена тестов, §19). */
  readonly vault: KeyVault;
  /** Репозиторий измерений над открытой БД (TASK-026). */
  readonly measurementRepo: BpMeasurementRepository;
  /** Шина событий main-процесса (TASK-009). */
  readonly events: EventBus;
  /** Логгер контейнера (категория app, §18). */
  readonly logger: HlLogger;
  /**
   * Реестр IPC-каналов каркаса (TASK-008): хендлеры зарегистрированы здесь (§11);
   * bootstrap ставит поверх транспортный мост installChannelBridge(container.channels).
   */
  readonly channels: ChannelRegistry;
  /**
   * Пул воркеров для CPU-задач (TASK-066 §5/§6: 2 worker_threads, ленивый) — PDF-рендер
   * (067), тяжёлый экспорт, series не блокируют main (NFR-4). Воркеры БД/ключ не трогают
   * (§8): данные передаются payload'ом.
   */
  readonly workerPool: WorkerPool;
  /**
   * Use case создания копии (TASK-070 §5): канал `backup/create` зарегистрирует
   * TASK-073 (с диалогами UI); сейчас используется hook'ом миграций (beforeMigration).
   */
  readonly createBackup: CreateBackupUseCase;
  /**
   * Очередь файловых операций данных (TASK-070 §9): копии и будущие экспорты
   * (TASK-063) выполняются строго по одной.
   */
  readonly fileOpQueue: FileOpQueue;
  /** Graceful shutdown (§8): wal_checkpoint(TRUNCATE) → close → terminate пула; идемпотентен. */
  close(): void;
}

/**
 * Читает schema_version для факта лога (§18). Свежая БД: таблицы meta ещё нет
 * (создаёт runner до первой миграции, TASK-024 §8) — трактуется как «миграций не
 * было» (0). Значение — только для телеметрии, решение о миграциях принимает runner.
 */
function readSchemaVersionForLog(db: EncryptedDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    return row !== undefined && /^\d+$/.test(row.value) ? Number(row.value) : 0;
  } catch {
    // Свежая БД — «no such table: meta»: миграций не было.
    return 0;
  }
}

/**
 * Дефолтная (боевая) фабрика vault-а: SafeStorageKeyVault на safeStorage Electron.
 * Electron импортируется ЛЕНИВО (см. шапку §20 п. 4): вне Electron-рантайма
 * safeStorage отсутствует — VAULT/UNAVAILABLE (§13 кейс 5), а не тихий сбой.
 */
async function createDefaultVault(context: VaultFactoryContext): Promise<KeyVault> {
  const electron = await import('electron');
  const safeStorage = (electron as { safeStorage?: VaultSafeStorage }).safeStorage;
  if (safeStorage === undefined) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9, прецедент sqlite.ts)
    throw AppError.of('VAULT/UNAVAILABLE', VAULT_UNAVAILABLE_MESSAGE_KEY, {
      platform: process.platform,
    });
  }
  return new SafeStorageKeyVault({
    vaultFilePath: context.vaultFilePath,
    safeStorage,
    clock: context.clock,
    logger: context.logger,
  });
}

/**
 * Собирает граф зависимостей приложения (§5). Порядок — см. шапку; любая ошибка
 * инициализации пробрасывается bootstrap → глобальный хендлер TASK-011 (§9).
 */
export async function buildContainer(deps: ContainerDeps): Promise<Container> {
  const clock = deps.clock ?? new SystemClock();

  // 1. Paths (§13: контейнер пути принимает параметрами — тестируемость; §8: БД внутри userData).
  const dbPath = join(deps.userDataPath, DATABASE_FILENAME);
  const vaultFilePath = join(deps.userDataPath, VAULT_KEY_FILENAME);
  const backupsDir = join(deps.userDataPath, BACKUPS_DIRNAME);
  const appVersion = deps.appVersion ?? DEFAULT_APP_VERSION;

  // 2. Logger (TASK-010): контейнер — категория app; vault/репозиторий — db; события — events.
  const logger = createLogger('app');
  const dbLogger = createLogger('db');

  // 3. Vault (§5: vault.ensureKey; фабрика переопределяема для тестов, §19).
  const vaultContext: VaultFactoryContext = { vaultFilePath, clock, logger: dbLogger };
  const vault =
    deps.vault !== undefined ? deps.vault(vaultContext) : await createDefaultVault(vaultContext);

  // dbExists решает сценарий vault-а (§13 кейс 4: файла ключа нет при существующей БД
  // → KEY_MISSING, новый ключ НЕ генерируется — различение по факту наличия файла БД).
  const dbExists = existsSync(dbPath);
  const ensured = await vault.ensureKey(dbExists);
  if (!ensured.ok) {
    // §9: наружу AppError с кодом VAULT/* (прецедент only-throw-error — sqlite.ts TASK-022).
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт init-ошибок §9: AppError в глобальный хендлер TASK-011
    throw ensured.error;
  }
  // §14: keyHex живёт только здесь — в граф и наружу не передаётся далее открытого ключа.
  const keyHex = ensured.value.keyHex;
  const keyCreated = ensured.value.created;

  // 4. БД (§5: openEncrypted(dbPath, keyHex) — единственная точка открытия, TASK-022).
  const db = openEncrypted(dbPath, keyHex);
  try {
    // 4.5. Data Care (TASK-070 §5): use case CreateBackup — ДО миграций: hook
    //      снапшота (beforeMigration) зовёт его перед каждой применяемой миграцией
    //      (§5/§22: порядок hook → DDL runner'а TASK-024). Авто-копии шифруются
    //      ключом БД (§8: kdf db-key) — keyHex живёт в замыкании, полем графа не
    //      становится и наружу не уходит (§14). Диалог сохранения — ленивый electron
    //      (боевой путь ask-режима; хендлер канала — TASK-073).
    const fileOpQueue = new FileOpQueue();
    const createBackup = new CreateBackupUseCase({
      db,
      clock,
      logger: dbLogger,
      crypto: new BackupContainerCodec(),
      fileSaver: new DialogFileSaver(),
      queue: fileOpQueue,
      backupsDir,
      appVersion,
      dbKeyHex: () => keyHex,
    });

    // 5. Миграции (старт БД §9 TASK-024: openEncrypted → migrate(); failure → STORAGE/*).
    //    TASK-070 §5: hook снапшота — createBackup(mode auto) перед каждой
    //    применяемой миграцией (pre-migration-vN.hlbackup в userData/backups, §7).
    const schemaVersionBefore = readSchemaVersionForLog(db);
    await new MigrationRunner({
      migrations: MIGRATIONS,
      beforeMigration: createPreMigrationBackupHook(createBackup),
    }).migrate(db);
    // После успешного migrate схема на максимальной версии реестра (иначе — throw выше).
    const schemaVersion = MIGRATIONS.at(-1)?.version ?? schemaVersionBefore;
    const migrationsApplied = schemaVersion - schemaVersionBefore;

    // 6. Репозиторий (TASK-026; боевой логгер createLogger('db') — TASK-026 §18).
    // БУДУЩАЯ РАБОТА (§23): сюда же встают use case'ы 029+ и прочие модули.
    const measurementRepo = new SqliteBpMeasurementRepository(db, { logger: dbLogger });
    // TASK-045 §5: адаптер FTS-поиска заметок над индексом миграции v2 (та же БД).
    const notesSearch = new NotesSearchAdapter(db, { logger: dbLogger });

    // 7. События (TASK-009): боевая категория events вместо консольного дефолта.
    const events = new EventBus(createLogger('events'));

    // 7.5. Прикладные use case'ы (§23, место помечено TASK-027): use case'ам нужны
    //      репозиторий (п. 6) и шина событий (п. 7), поэтому — между ними и IPC.
    //      TASK-029: AddMeasurement публикует measurement:changed/data:versionBumped.
    //      TASK-030: ListMeasurements — тонкое чтение журнала (событий не публикует).
    //      TASK-032: DeleteMeasurement — удаление созданного в потоке «Проверьте
    //      значения»; события — в порядке add.
    //      TASK-037: UpdateMeasurement — полная правка через edit-фабрику; typo
    //      пересчитывается без правимой записи, duplicate не пересчитывается.
    //      TASK-045: SearchNotes — FTS-поиск заметок (событий не публикует).
    const addMeasurement = new AddMeasurementUseCase({
      repo: measurementRepo,
      clock,
      events,
      logger,
    });
    const listMeasurements = new ListMeasurementsUseCase({ repo: measurementRepo, logger });
    const searchNotes = new SearchNotesUseCase({ search: notesSearch, logger });
    const deleteMeasurement = new DeleteMeasurementUseCase({
      repo: measurementRepo,
      events,
      logger,
    });
    const updateMeasurement = new UpdateMeasurementUseCase({
      repo: measurementRepo,
      clock,
      events,
      logger,
    });
    //      TASK-047: PreferencesService — единый документ prefs в app_setting v3;
    //      set публикует prefs:changed (renderer перечитывает — мгновенное
    //      применение темы/масштаба, §10).
    const settingsStore = new SettingsStore(db, { clock, logger: dbLogger });
    const preferencesService = new PreferencesService({ store: settingsStore, events, logger });
    //      TASK-051: ScaleService — активация данных пакета @hl/scales-data в
    //      reference_scale v4 (идемпотентно, §5/§9) и чтение активной шкалы для
    //      канала scales/active; кэш в памяти (§15).
    const scaleRepo = new SqliteScaleRepository(db, { clock, logger: dbLogger });
    const scaleService = new ScaleService({ repo: scaleRepo, logger, data: BP_OFFICE_ESC2018 });
    // Активация — часть старта (§5): отказ STORAGE/* пробрасывается выше →
    // глобальный хендлер TASK-011 (шкала критична, §7).
    await scaleService.ensureActivated();
    //      TASK-054: GetPeriodStatistics — use case канала stats/period (тонкая
    //      сборка: период → границы → точки порта → read model 052 + classification
    //      053 → {stats, scale}). Порт точек — адаптер над журналом измерений
    //      (без нового SQL), шкала — ScaleService выше.
    const measurementPoints = new MeasurementPointsAdapter(measurementRepo);
    const getPeriodStatistics = new GetPeriodStatistics({
      points: measurementPoints,
      scales: scaleService,
      clock,
    });
    //      TASK-056: TrendSeries — read model серий точек графика (тот же порт точек,
    //      без нового SQL; режим raw/daily по порогу 500 решает read model, §2).
    const trendSeries = new TrendSeries({ points: measurementPoints, clock });
    //      TASK-065: экспорт CSV/JSON (US-27) — источники §8 над боевой инфраструктурой
    //      (адаптеры reporting), генерация use case'ами 063/064, запись — через ОБЩУЮ
    //      очередь fileOpQueue (§9: не пересекается с копией БД) и боевой
    //      ElectronFileSaver (диалог ОС всегда, арх. 02 §3.4; prefs — PreferencesService,
    //      шкалы — проекция ActiveScale в {code, version}).
    const fileSaver = new ElectronFileSaver();
    const exportCsvFile = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({
        source: new MeasurementExportAdapter(measurementRepo),
        logger,
      }),
      saver: fileSaver,
      queue: fileOpQueue,
      clock,
      logger,
    });
    const exportJsonFile = new ExportJsonFileUseCase({
      generate: new ExportJsonUseCase({
        source: new JsonSnapshotSource({ db, repo: measurementRepo }),
        prefs: preferencesService,
        scales: {
          listActiveScales: () =>
            scaleService
              .getActiveScale()
              .then((scale) => [{ code: scale.code, version: scale.version }]),
        },
        clock,
        appVersion,
        logger,
      }),
      saver: fileSaver,
      queue: fileOpQueue,
      clock,
      logger,
    });
    //      TASK-068: PDF-отчёт (UC-05) — use case над боевыми частями: сырые точки —
    //      ReportPointsAdapter над журналом (§5: таблице нужен raw, не daily 056),
    //      статистика — ReportStatsAdapter над портом точек + read model 052 (§5
    //      «stats (054)»), рендер — WorkerPool ниже (создан здесь, воркеры ленивые),
    //      запись — ОБЩАЯ очередь fileOpQueue (§4: очередь сериализует только ЗАПИСЬ).
    //      Составляющая создания копии у fileOpQueue та же — один инстанс (§9).
    //
    //      Пул воркеров CPU-задач (TASK-066 §5/§6): 2 worker_threads, ленивое создание
    //      при первой задаче (потоки при старте не спавнятся); воркеры без доступа к
    //      БД/ключу (§8). TASK-067 §9: дефолт tasksModule — модуль задач reporting
    //      (pdf.render); тесты подставляют свой через deps.workerPool. Лог —
    //      категория job (§18: job start/end, краш).
    const workerPool = new WorkerPool({
      ...deps.workerPool,
      tasksModule: deps.workerPool?.tasksModule ?? PDF_TASKS_MODULE_URL.href,
      logger: createLogger('job'),
    });
    //      Карта задач боевого пула шире карты 067 (run возвращает unknown) — сужение
    //      до PdfRenderRunner в точке сборки (прецедент container-pdf.int.test.ts:
    //      run('pdf.render') as PdfRenderResult).
    const pdfRenderRunner: PdfRenderRunner = {
      run: (name, payload) => workerPool.run(name, payload) as Promise<PdfRenderResult>,
    };
    const buildPdfReport = new BuildPdfReportUseCase({
      points: new ReportPointsAdapter(measurementRepo),
      stats: new ReportStatsAdapter(measurementPoints),
      pool: pdfRenderRunner,
      saver: fileSaver,
      queue: fileOpQueue,
      clock,
      appVersion,
      logger,
    });

    // 8. IPC-регистрация (§11 — в конце buildContainer): хендлеры каркаса и каналы
    //    прикладных use case'ов. ping (TASK-008) — время из Clock контейнера
    //    (детерминизм тестов, NFR-10); app/log-client-error (TASK-011) — прикладной
    //    канал ErrorBoundary; measurements/add (TASK-029) — use case addMeasurement;
    //    measurements/list (TASK-030) — use case listMeasurements; measurements/delete
    //    (TASK-032) — use case deleteMeasurement; measurements/update (TASK-037) —
    //    use case updateMeasurement (сводная регистрация всех 4 каналов журнала).
    const channels = createChannelRegistry(createLogger('ipc'));
    channels.register('app/ping', CHANNEL_SCHEMAS['app/ping'], createPingHandler(clock));
    channels.register(
      'app/log-client-error',
      CHANNEL_SCHEMAS['app/log-client-error'],
      createLogClientErrorHandler(logger),
    );
    channels.register(
      'measurements/add',
      CHANNEL_SCHEMAS['measurements/add'],
      createAddMeasurementHandler(addMeasurement),
    );
    channels.register(
      'measurements/list',
      CHANNEL_SCHEMAS['measurements/list'],
      createListMeasurementHandler(listMeasurements),
    );
    channels.register(
      'measurements/update',
      CHANNEL_SCHEMAS['measurements/update'],
      createUpdateMeasurementHandler(updateMeasurement),
    );
    channels.register(
      'measurements/delete',
      CHANNEL_SCHEMAS['measurements/delete'],
      createDeleteMeasurementHandler(deleteMeasurement),
    );
    // TASK-045 §5/§11: notes/search — use case searchNotes (мусорный запрос —
    // пустой результат, не ошибка; ошибки канала — только APP/INTERNAL).
    channels.register(
      'notes/search',
      CHANNEL_SCHEMAS['notes/search'],
      createSearchNotesHandler(searchNotes),
    );
    // TASK-047 §5/§11: prefs/get|set — use case preferencesService (дефолты/merge —
    // сервис; patch валидирует strip-схема каркаса и сервис; STORAGE/* — адаптер).
    channels.register(
      'prefs/get',
      CHANNEL_SCHEMAS['prefs/get'],
      createGetPrefsHandler(preferencesService),
    );
    channels.register(
      'prefs/set',
      CHANNEL_SCHEMAS['prefs/set'],
      createSetPrefsHandler(preferencesService),
    );
    // TASK-051 §5/§11: scales/active — активная шкала в форме ActiveScale
    // (статический между запусками; кэш рендерера staleTime Infinity, §11).
    channels.register(
      'scales/active',
      CHANNEL_SCHEMAS['scales/active'],
      createGetActiveScaleHandler(scaleService),
    );
    // TASK-054 §5/§11: stats/period — use case getPeriodStatistics; лог длительности
    // §18 (`stats/period period=… durationMs=… count=…`) — категория ipc.
    channels.register(
      'stats/period',
      CHANNEL_SCHEMAS['stats/period'],
      createGetPeriodStatisticsHandler(getPeriodStatistics, createLogger('ipc')),
    );
    // TASK-056 §5/§11: trend/series — read model trendSeries; лог длительности §18
    // (`trend/series period=… mode=… points=N durationMs=…`) — категория ipc.
    channels.register(
      'trend/series',
      CHANNEL_SCHEMAS['trend/series'],
      createTrendSeriesHandler(trendSeries, createLogger('ipc')),
    );
    // TASK-065 §5/§11: report/export-csv|json — файловый экспорт (save-диалог main
    // всегда, §3.4; отмена → {canceled: true}, §7; телеметрия §18 — в оркестраторе).
    channels.register(
      'report/export-csv',
      CHANNEL_SCHEMAS['report/export-csv'],
      createExportCsvHandler(exportCsvFile),
    );
    channels.register(
      'report/export-json',
      CHANNEL_SCHEMAS['report/export-json'],
      createExportJsonHandler(exportJsonFile),
    );
    // TASK-068 §5/§11: report/pdf — use case buildPdfReport (пул → очередь →
    // save-диалог; отмена → {canceled: true}, §7; EMPTY_PERIOD/RENDER_FAILED — §7);
    // app/reveal-path — «открыть папку» после сохранения (fire-and-forget §9:
    // отказ боевого адаптера вне Electron/при исчезнувшем файле глушится warn-ом,
    // конверт всегда ok null).
    channels.register(
      'report/pdf',
      CHANNEL_SCHEMAS['report/pdf'],
      createBuildPdfReportHandler(buildPdfReport),
    );
    channels.register(
      'app/reveal-path',
      CHANNEL_SCHEMAS['app/reveal-path'],
      createRevealPathHandler((path) => {
        void electronRevealPath(path).catch(() => {
          // §18: без путей и причин (userData содержит имя Windows-пользователя).
          logger.warn('app/reveal-path: не удалось открыть папку с файлом');
        });
      }),
    );

    // 9. Лог готовности (§18): факты без путей (basename файла БД — без имени пользователя).
    logger.info('container ready', {
      db: basename(dbPath),
      schemaVersion,
      keyCreated,
      migrationsApplied,
      backupHook: 'on',
    });

    let closed = false;
    return {
      db,
      clock,
      vault,
      measurementRepo,
      events,
      logger,
      channels,
      workerPool,
      createBackup,
      fileOpQueue,
      close(): void {
        if (closed) {
          return; // идемпотентность: повторный will-quit — no-op
        }
        closed = true;
        try {
          // §8: чекпоинт перед закрытием — чистое отсутствие -wal/-shm после выхода.
          db.pragma('wal_checkpoint(TRUNCATE)');
        } finally {
          db.close();
        }
        // §9: пул — ПОСЛЕ закрытия БД (воркеры БД не открывают, §8); задачи обрываются
        // (потерянный PDF при закрытии приложения допустим, §9), активные и ожидающие
        // job отклоняются — will-quit не висит (AC4). terminate async — fire-and-forget.
        logger.info('worker pool shutdown: terminating', { reason: 'will-quit' });
        void workerPool.terminate();
      },
    };
  } catch (error) {
    // §13: контейнер не создаётся — открытый дескриптор не переживает неудачную сборку
    // (Windows: файл заблокирован для удаления; прецедент openEncrypted TASK-022).
    try {
      db.close();
    } catch {
      // соединение уже закрыто — при пробросе ошибки это не важно
    }
    throw error;
  }
}
