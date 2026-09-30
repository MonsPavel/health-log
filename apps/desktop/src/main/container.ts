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
 * AI-модуль (076+). EgressGateway подключён (075, §9 — singleton). Рост: при >15
 * зависимостях — деление на per-module секции-фабрики (§22).
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { basename, join } from 'node:path';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import type { BackupCreateRequest } from '@hl/contracts';
import { AppError, err, ok, SystemClock, type Clock, type Result } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';

import { createLogClientErrorHandler } from './app/global-errors.js';
import { EventBus } from './events/event-bus.js';
import { broadcastToWindows } from './events/broadcast.js';
import { ElectronFileSaver } from './platform/file-saver.js';
import { electronFileOpenDialog } from './platform/file-open.js';
import { BackupContainerCodec } from './modules/data-care/adapters/backup-container.js';
import { DialogFileSaver } from './modules/data-care/adapters/dialog-file-saver.js';
import {
  CreateBackupUseCase,
  createPreMigrationBackupHook,
  type CreateBackupResult,
} from './modules/data-care/application/create-backup.js';
import {
  BACKUP_REMINDER_KIND,
  createBackupReminderJob,
  jobStateWithBackup,
} from './modules/data-care/application/backup-reminder-job.js';
import {
  RestoreBackupUseCase,
  cleanupRestoreSafetyCopy,
} from './modules/data-care/application/restore-backup.js';
import { WipeAllDataUseCase } from './modules/data-care/application/wipe-all.js';
import { FileOpQueue } from './modules/data-care/application/file-op-queue.js';
import {
  createAddMeasurementHandler,
  createListMeasurementHandler,
  createUpdateMeasurementHandler,
} from './ipc/handlers/measurements.js';
import { createDeleteMeasurementHandler } from './ipc/handlers/measurements-delete.js';
import {
  createBackupCreateHandler,
  createBackupRestoreHandler,
  createDataWipeHandler,
} from './ipc/handlers/data-care.js';
import { createFileOpenDialogHandler } from './ipc/handlers/file-open-dialog.js';
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
import {
  BuildPdfReportUseCase,
  type PdfRenderRunner,
} from './modules/reporting/application/build-pdf-report.js';
import type { PdfRenderResult } from './modules/reporting/application/report-spec.js';
// TASK-067 §9: дефолт tasksModule пула — модуль задач reporting (лёгкий файл URL:
// без импортов цепочки react-pdf — рендер живёт в воркере, не в графе main).
import { PDF_TASKS_MODULE_URL } from './modules/reporting/adapters/pdf/pdf-tasks-url.js';
import { SqliteBpMeasurementRepository } from './modules/measurement/adapters/sqlite-measurement-repository.js';
import { NotesSearchAdapter } from './modules/measurement/adapters/notes-search.js';
// TASK-075 §5/§9: EgressGateway — единственная точка сети приложения (D11).
import {
  createDefaultEgressFetch,
  EgressGateway,
} from './modules/platform-services/egress/egress-gateway.js';
// TASK-076 §5/§9: LlmProcessClient — main-side клиент llm-worker (UtilityProcess).
import {
  createDefaultLlmWorkerSpawn,
  LlmProcessClient,
} from './modules/ai-insight/adapters/llm-process-client.js';
// TASK-078 §5: выбор движка за портом LlmEngine — ProcessLlmEngine (клиент 076)
// или FakeLlmEngine (dev/e2e без модели, env HL_FAKE_LLM=1).
import { FakeLlmEngine } from './modules/ai-insight/adapters/fake-llm-engine.js';
import { ProcessLlmEngine } from './modules/ai-insight/adapters/process-llm-engine.js';
// TASK-081 §5/§9: ModelStore (080) — singleton графа (проводка здесь), реестр
// манифеста 079 и use case витрины моделей; хендлеры ai/models/* (§11).
import { ModelStore } from './modules/ai-insight/adapters/model-store.js';
import { ModelsRegistry } from './modules/ai-insight/adapters/models-registry.js';
import {
  AiModelsQueries,
  type TestModelInstallPort,
} from './modules/ai-insight/application/models-queries.js';
import {
  createAiModelsDownloadHandler,
  createAiModelsListHandler,
  createAiModelsPauseHandler,
  createAiModelsResetHandler,
  createAiModelsResumeHandler,
  createAiModelsSelectHandler,
} from './ipc/handlers/ai-models.js';
import type { LlmEngine } from './modules/ai-insight/application/ports/llm-engine.js';
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
import { JobScheduler } from './shared/scheduler/scheduler.js';
import { WorkerPool, type WorkerPoolOptions } from './shared/workerpool/pool.js';
import { electronRevealPath } from './platform/reveal-path.js';

/** Имя файла БД в userData (§8): `<userData>/health-log.db` (+ `-wal`, `-shm`). */
export const DATABASE_FILENAME = 'health-log.db';

/**
 * TASK-078 §5/§14: имя env-флага dev-режима fake-LLM (§5: HL_FAKE_LLM=1;
 * единственный источник строки) и гард его применения: флаг действует ТОЛЬКО
 * в не-packaged запуске (§14 — тот же паттерн, что HL_BENCH: benchChannelsEnabled,
 * TASK-062; тест-эмуляция packaged — container-llm-engine.int.test.ts). Bootstrap
 * передаёт результат параметром useFakeLlm — контейнер сам process.env не читает
 * (§19: тесты без env-мутаций).
 */
export const HL_FAKE_LLM_ENV = 'HL_FAKE_LLM';

export function fakeLlmEnabled(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): boolean {
  return env[HL_FAKE_LLM_ENV] === '1' && !isPackaged;
}

/**
 * TASK-081 §22/§14: имя env-флага тестовой установки модели мимо сети (§22:
 * реальный URL моделей появится после отбора — dev-модель с PLACEHOLDER-URL
 * манифеста 079 сетевой путь 080 не проходит; e2e §20-6 нужен) и гард его
 * применения: ТОЛЬКО не-packaged запуск (паттерн fakeLlmEnabled выше; строка —
 * ПУТЬ локального файла-источника). Bootstrap передаёт путь параметром
 * testModelFilePath — контейнер сам process.env не читает (§19).
 */
export const HL_TEST_MODEL_FILE_ENV = 'HL_TEST_MODEL_FILE';

export function testModelFileEnabled(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): boolean {
  const value = env[HL_TEST_MODEL_FILE_ENV];
  return typeof value === 'string' && value.length > 0 && !isPackaged;
}

/**
 * Профиль дневника (seed миграции v1; bench-seed.ts — тот же идентификатор):
 * счётчик записей задачи backup.reminder считается по нему (§13).
 */
const SEED_PROFILE_ID = 'seed-profile-0001';

/** Каталог копий в userData (TASK-070 §7 — фикс): `<userData>/backups/`. */
export const BACKUPS_DIRNAME = 'backups';

/**
 * Каталог установленных моделей (TASK-081 §5, арх. 07 §6): `<userData>/models` —
 * тот же, что внутри ModelStore (080).
 */
export const MODELS_DIRNAME = 'models';

/**
 * TASK-081 §7/§17: язык интерфейса приложения — поле list-ответа для
 * предупреждения FR-5.9 (язык модели ≠ язык UI). MVP — единственный каталог
 * 'ru' (i18n §17: второй язык пост-MVP); константа — единственное место знания.
 */
const APP_UI_LANGUAGE = 'ru';

/**
 * Файл-флаг страховки восстановления (TASK-071 §14) в userData: путь вводится в
 * use case RestoreBackup (сборка), удаление при успешном старте —
 * cleanupRestoreSafetyCopy ниже (подключение 073).
 */
export const RESTORE_SAFETY_FLAG_FILENAME = 'restore-safety.flag';

/**
 * Отложенный перезапуск приложения (TASK-071/072 §9): app.relaunch() + app.exit(0)
 * через 500 мс — ответ канала успевает уйти рендереру до выхода (деталь §9,
 * зафиксированная в restore-backup.ts). Electron импортируется лениво: сборка
 * контейнера идёт и в node-окружении vitest (§19) — функция вызывается только из
 * use case'ов восстановления/удаления.
 */
function scheduleAppRelaunch(): void {
  setTimeout(() => {
    void import('electron').then((electron) => {
      const app = (electron as { app?: { relaunch(): void; exit(code?: number): void } }).app;
      app?.relaunch();
      app?.exit(0);
    });
  }, 500);
}

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
  /**
   * Каталог логов (TASK-072 §5: категория logs плана полного удаления). Bootstrap
   * передаёт app.getPath('logs'); по умолчанию — `<userData>/logs` (Windows-дефолт
   * getPath('logs') — userData/logs).
   */
  readonly logsDirPath?: string;
  /**
   * TASK-078 §5/§19: dev/e2e-режим fake-LLM — использовать FakeLlmEngine вместо
   * боевого ProcessLlmEngine (генерация детерминированная, без модели/процесса).
   * Bootstrap передаёт fakeLlmEnabled(process.env, app.isPackaged) (env
   * HL_FAKE_LLM=1, только не-packaged — §14); по умолчанию false. Параметром, а
   * не чтением env здесь — тесты без process.env-мутаций (§19).
   */
  readonly useFakeLlm?: boolean;
  /**
   * TASK-081 §22: TEST-ONLY путь локального файла «модели» для установки мимо
   * сети (e2e §20-6; реальный URL моделей появится после отбора — §22). Bootstrap
   * передаёт process.env[HL_TEST_MODEL_FILE_ENV] при гарде testModelFileEnabled
   * (не-packaged, §14); undefined — боевой сетевой путь ModelStore.
   */
  readonly testModelFilePath?: string;
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
  /**
   * Планировщик каркасных задач (TASK-074 §5): реестр + первая задача
   * backup.reminder зарегистрированы при сборке; tick при старте вызывает
   * bootstrap (§9 — «после контейнера»: запись jobState не соревнуется
   * с prefs-вызовами сборки).
   */
  readonly scheduler: JobScheduler;
  /**
   * EgressGateway — ЕДИНСТВЕННАЯ точка сети приложения (TASK-075 §5/§9, D11):
   * белый список EgressPolicy + согласия prefs.netConsents + журнал network_event
   * (v5) + событие net:activity. Потребители — TASK-080 (модели), TASK-096
   * (обновления); журнал — TASK-099.
   */
  readonly egress: EgressGateway;
  /**
   * Клиент llm-worker (TASK-076 §5/§9) — синглтон контейнера: spawn
   * UtilityProcess ленивый (первая операция), события ai:status/ai:token — в
   * боевой мост broadcastToWindows (§11). Потребители — use case'ы ai-insight
   * (TASK-077/087+); реальный движок подключит 077.
   */
  readonly llm: LlmProcessClient;
  /**
   * Движок LLM за application-портом (TASK-078 §5) — единственная точка
   * генерации для use case'ов ai-insight (087+): ProcessLlmEngine (обёртка
   * клиента `llm` выше) или FakeLlmEngine (dev/e2e, useFakeLlm). В fake-режиме
   * клиент не спавнится (ленивый) и потребителями не используется.
   */
  readonly llmEngine: LlmEngine;
  /**
   * Use case витрины моделей (TASK-081 §5/§9): list/download/pause/resume/reset/
   * select над ModelStore (080) и реестром манифеста 079; потребители — хендлеры
   * ai/models/* (§11) и e2e §20-6.
   */
  readonly aiModels: AiModelsQueries;
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
    //      TASK-073 §5/§11: use case'ы восстановления и полного удаления — та же
    //      инфраструктура (очередь fileOpQueue, криптоконтейнер, dbLogger); точки
    //      контейнера: закрытие БД (checkpoint+close), повторное открытие подменённой
    //      БД тем же ключом (verifyDatabaseOpens — §8 071), отложенный relaunch (§9).
    //      Каталоги/файлы wipe — фактические пути main (§14: renderer пути не шлёт).
    const closeCurrentDb = (): void => {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    };
    const restoreBackup = new RestoreBackupUseCase({
      currentDb: db,
      closeCurrentDb,
      dbPath,
      verifyDatabaseOpens: (path) => {
        openEncrypted(path, keyHex).close();
      },
      crypto: new BackupContainerCodec(),
      logger: dbLogger,
      queue: fileOpQueue,
      relaunch: scheduleAppRelaunch,
      safetyFlagPath: join(deps.userDataPath, RESTORE_SAFETY_FLAG_FILENAME),
      clock,
      appVersion,
    });
    const wipeAllData = new WipeAllDataUseCase({
      db,
      closeCurrentDb,
      dbPath,
      vaultKeyPath: vaultFilePath,
      logsDir: deps.logsDirPath ?? join(deps.userDataPath, 'logs'),
      backupsDir,
      logger: dbLogger,
      queue: fileOpQueue,
      relaunch: scheduleAppRelaunch,
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

    // 5.5. Data Care (TASK-073, подключение §14 071): страховка прошлого
    //      восстановления удаляется при УСПЕШНОМ старте (БД открыта и промигрирована
    //      — она больше не нужна); сбой чистки старт не валит (best-effort boolean).
    if (cleanupRestoreSafetyCopy(join(deps.userDataPath, RESTORE_SAFETY_FLAG_FILENAME))) {
      dbLogger.debug('restoreBackup: страховка прошлого восстановления удалена при старте');
    }

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
    //      TASK-074 §5/§9: JobScheduler — реестр задач каркаса и первая задача
    //      backup.reminder. Store — PreferencesService (lastRun/lastShown —
    //      персистентно в prefs.jobState, §12); sink — доставка решения о показе:
    //      событие job:backup-reminder renderer-у (§11) + лог §18 shown/snoozed.
    //      Повторный tick при каждом старте безопасен: частоту ограничивает
    //      дедупликация scheduler'а (1/7д, jobState.shown — §13). Сам tick при
    //      старте вызывает bootstrap ПОСЛЕ сборки (§9 — «после контейнера»).
    const scheduler = new JobScheduler({
      store: preferencesService,
      sink: {
        show: (kind) => {
          if (kind === BACKUP_REMINDER_KIND) {
            logger.info('job backup-reminder shown');
            events.emit('job:backup-reminder', {});
          }
        },
        snooze: (kind) => {
          if (kind === BACKUP_REMINDER_KIND) {
            logger.info('job backup-reminder snoozed');
          }
        },
      },
      logger,
    });
    scheduler.register(
      createBackupReminderJob({
        // §13: счётчик записей дневника — COUNT журнала (seed-профиль миграции v1).
        countMeasurements: () => measurementRepo.countByPeriod({ profileId: SEED_PROFILE_ID }),
      }),
    );
    //      TASK-075 §5/§9: EgressGateway — singleton контейнера, единственная точка
    //      сети (D11). Согласия — read-only срез prefs (§14; перечитываются на каждый
    //      запрос — отмена согласия мгновенна); исполнитель — net.fetch Electron
    //      (прокси ОС, §4; в node-vitest — фолбэк globalThis.fetch, до сети боевые
    //      тесты не доходят — guard FR-7.2); доставка net:activity — боевой мост
    //      broadcastToWindows (TASK-009) на живые окна (§11); журнал — network_event
    //      v5, лог — категория net (§18).
    const egressFetch = await createDefaultEgressFetch();
    const egress = new EgressGateway({
      db,
      clock,
      logger: createLogger('net'),
      consents: async () => (await preferencesService.getPrefs()).netConsents,
      fetch: egressFetch,
      notify: broadcastToWindows,
    });
    //      TASK-076 §5/§9: LlmProcessClient — синглтон контейнера. Spawn ленивый
    //      (первая операция — сборка контейнера в node-vitest не спавнит, §19);
    //      боевая фабрика — utilityProcess.fork + MessageChannelMain (ленивый
    //      import electron, прецедент createDefaultEgressFetch: вне Electron-
    //      рантайма честный отказ при ВЫЗОВЕ); события ai:status/ai:token — боевой
    //      мост broadcastToWindows (§11, как net:activity); лог — категория ai (§18).
    const llmWorkerSpawn = await createDefaultLlmWorkerSpawn();
    const llm = new LlmProcessClient({
      spawn: llmWorkerSpawn,
      notify: broadcastToWindows,
      logger: createLogger('ai'),
    });
    //      TASK-078 §5: движок LLM за портом LlmEngine — единственная точка
    //      генерации для use case'ов (087+). Dev/e2e (useFakeLlm — bootstrap
    //      передаёт гард fakeLlmEnabled(env, isPackaged) по env HL_FAKE_LLM=1,
    //      только не-packaged, §14) — FakeLlmEngine: детерминированные ответы с
    //      префиксом [FAKE], без модели и процессов. Боевой путь — ProcessLlmEngine
    //      над клиентом выше. В fake-режиме клиент НЕ спавнится (ленивый) и
    //      потребителями не используется; dispose в close() — безопасный no-op.
    const useFakeLlm = deps.useFakeLlm ?? false;
    const llmEngine: LlmEngine = useFakeLlm
      ? new FakeLlmEngine()
      : new ProcessLlmEngine({ client: llm });
    //      Телеметрия выбора движка (§18); предупреждение при fake — риск §22
    //      («fake-ответы уйдут в продакшн-скриншоты»; строка «FAKE» в «О приложении»
    //      появится с самим экраном — интерфейс рендерера вне §6 этой задачи).
    if (useFakeLlm) {
      logger.warn('fake LLM активен: генерация — детерминированная заглушка, не выводы модели', {
        engine: 'fake',
      });
    } else {
      logger.info('llm engine: process llm-worker', { engine: 'process' });
    }
    //      TASK-081 §5/§9: ModelStore (080) — singleton графа (проводка — здесь):
    //      каталог моделей <userData>/models (арх. 07 §6), реестр манифеста 079
    //      (ресурс комплекта — MODELS_MANIFEST_SCHEMA при каждом listModels),
    //      сеть — ТОЛЬКО боевой EgressGateway выше (D11, op models.download),
    //      прогресс ai:progress — боевой мост broadcastToWindows (§11), лог —
    //      категория ai (§18). Реестр создан до store: тест-install (§22) тоже
    //      резолвит имя файла по манифесту.
    const modelsRegistry = new ModelsRegistry({ logger: createLogger('ai') });
    const modelsDir = join(deps.userDataPath, MODELS_DIRNAME);
    const modelStore = new ModelStore({
      modelsDir,
      registry: modelsRegistry,
      egress,
      notify: broadcastToWindows,
      logger: createLogger('ai'),
    });
    //      TASK-081 §22: TEST-ONLY установка мимо сети — порт над node:fs,
    //      собранный контейнером из deps.testModelFilePath (гард env/не-packaged —
    //      bootstrap, §14): резолв имени файла по манифесту → copyFile в каталог
    //      моделей. Верификации нет — это test-hook (§22), в packaged не попадает.
    const testModelInstall: TestModelInstallPort | undefined =
      deps.testModelFilePath === undefined
        ? undefined
        : {
            isEnabled: () => true,
            install: async (modelId) => {
              try {
                const descriptor = modelsRegistry
                  .listModels()
                  .find((model) => model.id === modelId);
                if (descriptor === undefined) {
                  return err(
                    AppError.of('AI/MODEL_NOT_FOUND', 'errors.AI_MODEL_NOT_FOUND', {
                      model: modelId,
                    }),
                  );
                }
                await mkdir(modelsDir, { recursive: true });
                await copyFile(deps.testModelFilePath as string, join(modelsDir, descriptor.file));
                logger.info('test model install: файл скопирован мимо сети', {
                  modelId,
                  file: descriptor.file,
                });
                return ok({ state: 'installed' });
              } catch (cause) {
                logger.warn('test model install: не удался', { modelId, cause });
                return err(
                  AppError.of(
                    'APP/INTERNAL',
                    'errors.internal',
                    { reason: 'test-model-install' },
                    cause,
                  ),
                );
              }
            },
          };
    //      Use case витрины (§5/§7): list — одним вызовом всё для экрана (ОЗУ
    //      машины — os.totalmem main, одна десятая ГБ — честное сравнение с
    //      minRamGb; язык UI — константа выше); select — prefs (ensureModel
    //      лениво — 087, §9).
    const aiModels = new AiModelsQueries({
      store: modelStore,
      registry: modelsRegistry,
      prefs: preferencesService,
      ramTotalGb: () => Math.round((totalmem() / 2 ** 30) * 10) / 10,
      uiLanguage: () => APP_UI_LANGUAGE,
      testInstall: testModelInstall,
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
    // TASK-073 §5/§11: Data Care — копия (070), восстановление план+execute (071),
    // полное удаление план+execute (072) и выбор файла копии (open-диалог main,
    // §14: путь возникает только в main). Рестарт после execute — отложенный
    // relaunch (scheduleAppRelaunch выше, §9).
    // TASK-074 §5: onSuccess канала копии — метаданные (путь/дата) в
    // prefs.jobState.lastBackup (чистая jobStateWithBackup); best-effort: сбой
    // записи jobState не отменяет созданную копию и не возвращается ошибкой.
    const backupCreateWithJobState: {
      execute(command: BackupCreateRequest): Promise<Result<CreateBackupResult, AppError>>;
    } = {
      execute: async (command) => {
        const result = await createBackup.execute(command);
        if (result.ok) {
          try {
            const prefs = await preferencesService.getPrefs();
            await preferencesService.setPrefs({
              jobState: jobStateWithBackup(
                prefs.jobState,
                result.value.path,
                result.value.manifest.createdAtUtc,
              ),
            });
          } catch (cause) {
            logger.warn('backup/create: метаданные копии не записаны в prefs', { cause });
          }
        }
        return result;
      },
    };
    channels.register(
      'backup/create',
      CHANNEL_SCHEMAS['backup/create'],
      createBackupCreateHandler(backupCreateWithJobState),
    );
    channels.register(
      'backup/restore',
      CHANNEL_SCHEMAS['backup/restore'],
      createBackupRestoreHandler(restoreBackup),
    );
    channels.register(
      'data/wipe',
      CHANNEL_SCHEMAS['data/wipe'],
      createDataWipeHandler(wipeAllData),
    );
    channels.register(
      'file/open-dialog',
      CHANNEL_SCHEMAS['file/open-dialog'],
      createFileOpenDialogHandler(electronFileOpenDialog),
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
    // TASK-081 §5/§11: витрина моделей — list одним вызовом (§7); download/resume —
    // финал флоу 080 (ход — событиями ai:progress); pause/reset — статус сразу;
    // select — prefs.aiSettings.modelId (ensureModel лениво — 087, §9).
    channels.register(
      'ai/models/list',
      CHANNEL_SCHEMAS['ai/models/list'],
      createAiModelsListHandler(aiModels),
    );
    channels.register(
      'ai/models/download',
      CHANNEL_SCHEMAS['ai/models/download'],
      createAiModelsDownloadHandler(aiModels),
    );
    channels.register(
      'ai/models/pause',
      CHANNEL_SCHEMAS['ai/models/pause'],
      createAiModelsPauseHandler(aiModels),
    );
    channels.register(
      'ai/models/resume',
      CHANNEL_SCHEMAS['ai/models/resume'],
      createAiModelsResumeHandler(aiModels),
    );
    channels.register(
      'ai/models/reset',
      CHANNEL_SCHEMAS['ai/models/reset'],
      createAiModelsResetHandler(aiModels),
    );
    channels.register(
      'ai/models/select',
      CHANNEL_SCHEMAS['ai/models/select'],
      createAiModelsSelectHandler(aiModels),
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
      scheduler,
      egress,
      llm,
      llmEngine,
      aiModels,
      close(): void {
        if (closed) {
          return; // идемпотентность: повторный will-quit — no-op
        }
        closed = true;
        try {
          // §8: чекпоинт перед закрытием — чистое отсутствие -wal/-shm после выхода.
          // TASK-073: БД может быть УЖЕ закрыта data-care-операцией (closeCurrentDb
          // restore 071/wipe 072 — замена/удаление) — чекпоинт тогда не нужен.
          db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          // соединение закрыто под контейнером — закрывать нечего
        } finally {
          try {
            db.close();
          } catch {
            // уже закрыто (тот же кейс) — will-quit не роняет приложение
          }
        }
        // §9: пул — ПОСЛЕ закрытия БД (воркеры БД не открывают, §8); задачи обрываются
        // (потерянный PDF при закрытии приложения допустим, §9), активные и ожидающие
        // job отклоняются — will-quit не висит (AC4). terminate async — fire-and-forget.
        logger.info('worker pool shutdown: terminating', { reason: 'will-quit' });
        void workerPool.terminate();
        // TASK-076 §9: клиент llm-worker — после пула: процесс ИИ убивается без
        // перезапуска, активная генерация отклоняется (потерянное резюме при
        // закрытии приложения допустимо — не сохранено и не потеряно, §8).
        llm.dispose();
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
