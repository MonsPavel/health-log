/**
 * TASK-027 §2/§5: composition root — ЕДИНСТВЕННОЕ место сборки графа зависимостей
 * приложения (ручной DI D13, арх. 03 §5): Clock → KeyVault → openEncrypted →
 * MigrationRunner → репозитории → EventBus → регистрация хендлеров IPC. Без
 * DI-фреймворка: граф мал и статичен; пересмотр при >10 модулей (арх. 03 §5).
 * Приложение стартует с реальной зашифрованной БД в userData.
 *
 * ПОРЯДОК ИНИЦИАЛИЗАЦИИ (§5): paths → logger (TASK-010) → vault.ensureKey →
 * openEncrypted(dbPath, keyHex) → миграции → репозиторий → события; регистрация
 * существующих IPC-хендлеров — в конце buildContainer (§11). Порядок полей Container —
 * конвенция читаемости §7 (db, clock, vault, measurementRepo, events, logger);
 * каналы каркаса и close добавлены задачей 027 (см. Container).
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
 * bootstrap вызывает его на app 'will-quit'.
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

import { createLogClientErrorHandler } from './app/global-errors.js';
import { EventBus } from './events/event-bus.js';
import { createPingHandler } from './ipc/handlers/ping.js';
import { createChannelRegistry, type ChannelRegistry } from './ipc/register-channel.js';
import { SqliteBpMeasurementRepository } from './modules/measurement/adapters/sqlite-measurement-repository.js';
import type { BpMeasurementRepository } from './modules/measurement/application/ports/bp-measurement-repository.js';
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

/** Имя файла БД в userData (§8): `<userData>/health-log.db` (+ `-wal`, `-shm`). */
export const DATABASE_FILENAME = 'health-log.db';

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
  /** Graceful shutdown (§8): wal_checkpoint(TRUNCATE) → close; идемпотентен. */
  close(): void;
}

/**
 * Читает schema_version для факта лога (§18). Свежая БД: таблицы meta ещё нет
 * (создаёт runner до первой миграции, TASK-024 §8) — трактуется как «миграций не
 * было» (0). Значение — только для телеметрии, решение о миграциях принимает runner.
 */
function readSchemaVersionForLog(db: EncryptedDatabase): number {
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
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

  // 2. Logger (TASK-010): контейнер — категория app; vault/репозиторий — db; события — events.
  const logger = createLogger('app');
  const dbLogger = createLogger('db');

  // 3. Vault (§5: vault.ensureKey; фабрика переопределяема для тестов, §19).
  const vaultContext: VaultFactoryContext = { vaultFilePath, clock, logger: dbLogger };
  const vault = deps.vault !== undefined ? deps.vault(vaultContext) : await createDefaultVault(vaultContext);

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
    // 5. Миграции (старт БД §9 TASK-024: openEncrypted → migrate(); failure → STORAGE/*).
    const schemaVersionBefore = readSchemaVersionForLog(db);
    await new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
    // После успешного migrate схема на максимальной версии реестра (иначе — throw выше).
    const schemaVersion = MIGRATIONS.at(-1)?.version ?? schemaVersionBefore;
    const migrationsApplied = schemaVersion - schemaVersionBefore;

    // 6. Репозиторий (TASK-026; боевой логгер createLogger('db') — TASK-026 §18).
    // БУДУЩАЯ РАБОТА (§23): сюда же встают use case'ы 029+ и прочие модули.
    const measurementRepo = new SqliteBpMeasurementRepository(db, { logger: dbLogger });

    // 7. События (TASK-009): боевая категория events вместо консольного дефолта.
    const events = new EventBus(createLogger('events'));

    // 8. IPC-регистрация (§11 — в конце buildContainer): существующие хендлеры каркаса.
    //    ping (TASK-008) — время из Clock контейнера (детерминизм тестов, NFR-10);
    //    app/log-client-error (TASK-011) — прикладной канал ErrorBoundary. Хендлеры
    //    задач 029+ регистрируются здесь же по мере появления (место помечено).
    const channels = createChannelRegistry(createLogger('ipc'));
    channels.register('app/ping', CHANNEL_SCHEMAS['app/ping'], createPingHandler(clock));
    channels.register(
      'app/log-client-error',
      CHANNEL_SCHEMAS['app/log-client-error'],
      createLogClientErrorHandler(logger),
    );

    // 9. Лог готовности (§18): факты без путей (basename файла БД — без имени пользователя).
    logger.info('container ready', {
      db: basename(dbPath),
      schemaVersion,
      keyCreated,
      migrationsApplied,
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
