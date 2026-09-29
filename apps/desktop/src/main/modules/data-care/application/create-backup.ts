/**
 * TASK-070 §5: use case CreateBackup — консистентный снапшот БД (VACUUM INTO во
 * время работы приложения, WAL: без остановки записи, §4) → AES-256-GCM контейнер
 * (формат HLBK1, adapters/backup-container.ts) с манифестом → файл `.hlbackup`.
 *
 * ПОРЯДОК (§5):
 *  1. FileOpQueue — сериализация с будущими экспортами (§9);
 *  2. путь назначения: `ask` → FileSaver-диалог (отмена → BACKUP/CANCELED, §13);
 *     `auto` (hook миграций) → `userData/backups/<targetName>` без диалога (§5/§7/§9);
 *  3. фаза snapshot: VACUUM INTO во временный файл tmpdir ОС (открытый текст НЕ
 *     пишется рядом с назначением — NFR-2) → sha256 снапшота → schema_version
 *     (из meta) и counts (COUNT измерений; таблицы ещё нет — 0: свежая БД);
 *  4. фаза encrypt: ключ содержимого (§8: пароль → Argon2id; авто — ключ БД),
 *     манифест {formatVersion, schemaVersion, appVersion, createdAtUtc, counts,
 *     dbSha256, kdf} (AAD) → контейнер во ВРЕМЕННЫЙ файл рядом с назначением
 *     (rename в пределах тома, Windows: EXDEV недопустим);
 *  5. фаза write: rename tmp → финальное имя; cleanup tmp в finally (§9);
 *  6. лог §18: `backup created sizeBytes=… durationMs=…` — только basename (путь
 *     userData содержит имя Windows-пользователя); пароль/соль не логируются (§14).
 *
 * РЕШЕНИЕ-ТРАКТОВКА (§7, документировано): копия hook'а переименовывается в
 * `pre-migration-vN.hlbackup` СРАЗУ после успешного создания (не после миграции) —
 * при СБОЕ миграции копия остаётся на месте (страховка именно тогда нужна; runner
 * повторит миграцию при следующем старте, копия перезапишется). Ошибка копии
 * останавливает миграцию ДО DDL (runner TASK-024: hook → DDL; STORAGE/MIGRATION_FAILED).
 *
 * Пароль копии (§13): пустой/из пробелов → VALIDATION/FAILED (копия без пароля
 * не создаётся); ≥8 символов — политика UI 073 (предупреждение, main не блокирует).
 * Пароль копии ≠ пароль приложения (§14, независимые секреты).
 *
 * Ошибки (§5): наружу только AppError значением Result (прецедент DeleteMeasurement):
 * `BACKUP/FAILED` (сбой снапшота/шифрования/записи — например, исчерпание диска;
 * исход в cause, память main, §14) и `BACKUP/CANCELED` (отказ диалога, §13).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  createReadStream,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import type { BackupManifest, BackupPhase } from '@hl/contracts';
import { AppError, type Clock, type Result } from '@hl/kernel';

import type { BackupDatabase } from './ports/backup-database.js';
import type { BackupCrypto } from './ports/backup-crypto.js';
import type { BackupFileSaver } from './ports/backup-file-saver.js';
import type { FileOpQueue } from './file-op-queue.js';

/** Ключи i18n-каталога (конвенция арх. 05 §29); тексты — TASK-101/073. */
export const BACKUP_FAILED_MESSAGE_KEY = 'errors.BACKUP_FAILED';
export const BACKUP_CANCELED_MESSAGE_KEY = 'errors.BACKUP_CANCELED';

/** Расширение контейнера копии (§2/§4). */
export const BACKUP_EXTENSION = '.hlbackup';
/** Версия формата контейнера (magic HLBK1 = 1, §4/§7). */
const BACKUP_FORMAT_VERSION = 1;
/** Префикс tmp-каталогов снапшота в tmpdir ОС (проверка чистки — тесты AC-5). */
const SNAPSHOT_TMP_PREFIX = 'hl-backup-snap-';
/** Префикс tmp-файла контейнера рядом с назначением (rename в пределах тома). */
const CONTAINER_TMP_PREFIX = '.hl-tmp-';

/** Минимальная поверхность логгера use case (§18; прецедент DeleteMeasurementLogger). */
export interface CreateBackupLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Команда создания копии (§5/§11: контракт канала — discriminated union по mode). */
export interface CreateBackupCommand {
  /** `ask` — пользовательская копия через диалог; `auto` — без диалога (hook/073). */
  readonly mode: 'ask' | 'auto';
  /** Пароль копии — обязателен для `ask` (§8); для `auto` не передаётся. */
  readonly passphrase?: string;
  /** Имя файла в каталоге копий для `auto` (§7: `pre-migration-vN.hlbackup`); иначе — метка времени. */
  readonly targetName?: string;
  /** Прогресс фаз (§5: snapshot/encrypt/write — coarse; spy в тестах, канал — 073). */
  readonly onProgress?: (phase: BackupPhase) => void;
}

/** Результат успешного создания (§18: ответ канала — basename; путь остаётся в main). */
export interface CreateBackupResult {
  /** Имя файла копии (basename — наружу renderer, §14/§18). */
  readonly file: string;
  /** Полный путь (main-память: хендлер/тесты; renderer не отправляется). */
  readonly path: string;
  /** Размер контейнера, байт. */
  readonly sizeBytes: number;
  /** Манифест копии (§2/§7). */
  readonly manifest: BackupManifest;
}

/** Зависимости use case (§7): подстановочные в тестах (§19). */
export interface CreateBackupDeps {
  /** Открытая БД (VACUUM INTO + meta/counts) — порт BackupDatabase. */
  readonly db: BackupDatabase;
  /** Порт времени (createdAtUtc/имя файла; FixedClock в тестах, NFR-10). */
  readonly clock: Clock;
  /** Логгер (§18) — категория db. */
  readonly logger: CreateBackupLogger;
  /** Криптоконтейнер (арх. 02 §3.5: порт BackupCrypto). */
  readonly crypto: BackupCrypto;
  /** Диалог сохранения (mode `ask`); `auto` не использует (§5/§9). */
  readonly fileSaver: BackupFileSaver;
  /** Очередь файловых операций (§9 — сериализация с экспортами). */
  readonly queue: FileOpQueue;
  /** Каталог копий `<userData>/backups` (§7 — фикс). */
  readonly backupsDir: string;
  /** Версия приложения для манифеста (§2; bootstrap — app.getVersion()). */
  readonly appVersion: string;
  /**
   * Hex-ключ БД для авто-копий (§8: kdf db-key). Замыкание контейнера — keyHex
   * не становится полем графа и наружу не уходит (§14, прецедент buildContainer).
   * Обязателен при mode `auto` (нарушение — TypeError, программная ошибка сборки).
   */
  readonly dbKeyHex?: () => string;
  /**
   * Корень tmp-каталогов снапшота (§5: tmpdir ОС); по умолчанию os.tmpdir(). Точка
   * наблюдения тестов (§19/AC-5: проверка чистки детерминированно — без гонок с
   * параллельными воркерами suite на общем tmpdir ОС).
   */
  readonly snapshotTmpRoot?: string;
}

/**
 * Use case создания копии (§5). Один экземпляр на приложение (контейнер TASK-027);
 * операции сериализуются FileOpQueue (§9).
 */
export class CreateBackupUseCase {
  constructor(private readonly deps: CreateBackupDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, исключения не пересекают слои. */
  async execute(command: CreateBackupCommand): Promise<Result<CreateBackupResult, AppError>> {
    return this.deps.queue.run(() => this.run(command));
  }

  /** Тело операции — под очередью (§9). */
  private async run(command: CreateBackupCommand): Promise<Result<CreateBackupResult, AppError>> {
    const startedAtMs = performance.now();
    try {
      // Валидация команды (§13): ask — пароль обязателен и непуст (после trim).
      if (command.mode === 'ask') {
        if (typeof command.passphrase !== 'string' || command.passphrase.trim().length === 0) {
          this.deps.logger.debug('createBackup: пустой пароль копии', { mode: command.mode });
          return errValidation();
        }
      } else if (this.deps.dbKeyHex === undefined) {
        // Нарушение контракта сборки (контейнер не замкнул keyHex) — программная ошибка.
        throw new TypeError(
          'CreateBackup: mode auto требует deps.dbKeyHex (§8: авто-копия шифруется ключом БД) — нарушение контракта сборки является программной ошибкой',
        );
      }

      // 2. Путь назначения (§5/§7).
      const destinationPath = await this.resolveDestination(command);
      if (typeof destinationPath !== 'string') {
        // Отказ диалога (§13): ожидаемый исход, не сбой — debug и CANCELED.
        this.deps.logger.debug('createBackup: диалог сохранения отменён', { mode: command.mode });
        return {
          ok: false,
          error: AppError.of('BACKUP/CANCELED', BACKUP_CANCELED_MESSAGE_KEY),
        };
      }

      // 3-5. Фазы (§5); tmp-снапшот в tmpdir ОС, tmp-контейнер рядом с назначением.
      command.onProgress?.('snapshot');
      const snapshotDir = mkdtempSync(
        join(this.deps.snapshotTmpRoot ?? tmpdir(), SNAPSHOT_TMP_PREFIX),
      );
      const tmpContainerPath = join(
        dirname(destinationPath),
        `${CONTAINER_TMP_PREFIX}${randomBytes(8).toString('hex')}`,
      );
      try {
        const snapshotPath = join(snapshotDir, 'snapshot.db');
        const dbSha256 = await this.snapshotDatabase(snapshotPath);

        command.onProgress?.('encrypt');
        const { kdf, contentKey } = await this.deps.crypto.prepareKey(
          command.mode === 'ask'
            ? { kind: 'passphrase', passphrase: command.passphrase ?? '' }
            : { kind: 'dbKey', keyHex: this.deps.dbKeyHex?.() ?? '' },
        );
        const manifest: BackupManifest = {
          ...this.buildManifest(dbSha256),
          kdf,
        };
        // Точные байты манифеста — с записью kdf (AAD привязывает ровно то, что в файле).
        const manifestJsonFinal = Buffer.from(JSON.stringify(manifest), 'utf8');

        const { sizeBytes } = await this.deps.crypto.writeContainer({
          manifestJson: manifestJsonFinal,
          contentKey,
          snapshotPath,
          destinationPath: tmpContainerPath,
        });

        command.onProgress?.('write');
        renameSync(tmpContainerPath, destinationPath);

        // Лог §18: факты без путей (basename) и секретов (§14).
        this.deps.logger.info('backup created', {
          file: basename(destinationPath),
          sizeBytes,
          mode: command.mode,
          durationMs: Math.round(performance.now() - startedAtMs),
        });
        return {
          ok: true,
          value: {
            file: basename(destinationPath),
            path: destinationPath,
            sizeBytes,
            manifest,
          },
        };
      } finally {
        // Cleanup tmp (§9/AC-5): снапшот (открытый текст!) и tmp-контейнер — всегда.
        rmSync(snapshotDir, { recursive: true, force: true });
        try {
          if (existsSync(tmpContainerPath)) {
            unlinkSync(tmpContainerPath);
          }
        } catch {
          // Файл занят (антивирус/индексатор) — best-effort: ОС подчистит tmp.
        }
      }
    } catch (error) {
      // §5: наружу только AppError — BACKUP/FAILED с исходом в cause (память main).
      this.deps.logger.error('createBackup: сбой создания копии', {
        code: 'BACKUP/FAILED',
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return {
        ok: false,
        error: AppError.of('BACKUP/FAILED', BACKUP_FAILED_MESSAGE_KEY, undefined, error),
      };
    }
  }

  /**
   * Путь назначения (§5/§7): ask — диалог FileSaver (null → CANCELED), расширение
   * `.hlbackup` добирается при отсутствии; auto — `<backupsDir>/<targetName|метка>`.
   * `string | null` вместо Result — внутренний помощник, null = отмена (§13).
   */
  private async resolveDestination(command: CreateBackupCommand): Promise<string | null> {
    if (command.mode === 'ask') {
      const picked = await this.deps.fileSaver.save({
        defaultPath: backupFileName(this.deps.clock.nowMs()),
      });
      if (picked === null) {
        return null;
      }
      return picked.endsWith(BACKUP_EXTENSION) ? picked : `${picked}${BACKUP_EXTENSION}`;
    }
    mkdirSync(this.deps.backupsDir, { recursive: true });
    return join(
      this.deps.backupsDir,
      command.targetName ?? backupFileName(this.deps.clock.nowMs()),
    );
  }

  /**
   * Фаза snapshot (§5): VACUUM INTO (консистентный снимок, шифрование сохраняется —
   * прагмы соединения действуют на новую БД, проверено roundtrip-тестом AC-1) →
   * потоковый sha256 файла снапшота.
   */
  private async snapshotDatabase(snapshotPath: string): Promise<string> {
    // Кавычки пути экранируются удвоением (SQL-литерал; tmp-путь без апострофов).
    const escaped = snapshotPath.replace(/'/g, "''");
    this.deps.db.exec(`VACUUM INTO '${escaped}'`);
    return sha256File(snapshotPath);
  }

  /**
   * Манифест без записи kdf (§2/§5): версия формата, схема, версия приложения,
   * время, счётчики, sha256. Запись kdf добавляется в run() после prepareKey —
   * фаза encrypt (соль/параметры известны только там).
   */
  private buildManifest(dbSha256: string): Omit<BackupManifest, 'kdf'> {
    return {
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: readSchemaVersion(this.deps.db),
      appVersion: this.deps.appVersion,
      createdAtUtc: this.deps.clock.nowMs(),
      counts: { measurements: countMeasurements(this.deps.db) },
      dbSha256,
    };
  }
}

/** Ключ каркасного кода валидации (contracts app-error-dto: errors.validation). */
const VALIDATION_MESSAGE_KEY = 'errors.validation';

/** Ошибка валидации команды (§13): существующий каркасный код VALIDATION/FAILED. */
function errValidation(): Result<CreateBackupResult, AppError> {
  return {
    ok: false,
    error: AppError.of('VALIDATION/FAILED', VALIDATION_MESSAGE_KEY),
  };
}

/** Имя файла копии по умолчанию: метка времени UTC (детерминизм FixedClock в тестах). */
function backupFileName(nowMs: number): string {
  const date = new Date(nowMs);
  const p2 = (value: number): string => String(value).padStart(2, '0');
  return (
    `health-log-backup-${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}` +
    `T${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}${BACKUP_EXTENSION}`
  );
}

/** Потоковый SHA-256 файла (hex, lowercase; §2: dbSha256 — 64 hex). */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * schema_version из meta (§5; свежая БД без meta — 0; прецедент
 * readSchemaVersionForLog container.ts / readSchemaVersion migration-runner.ts).
 */
function readSchemaVersion(db: BackupDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    return row !== undefined && /^\d+$/.test(row.value) ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

/** COUNT измерений (§5/§15); таблицы ещё нет (свежая БД до v1) — 0. */
function countMeasurements(db: BackupDatabase): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM bp_measurement').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/**
 * Hook снапшота миграций TASK-024 (§5/§22): createBackup(mode auto) во временный
 * каталог без диалога; имя фикс §7 — `pre-migration-v{version}.hlbackup`. Ошибка
 * копии пробрасывается — runner оборачивает в STORAGE/MIGRATION_FAILED ДО DDL
 * (порядок hook → DDL, TASK-024 §13; AC-4).
 */
export function createPreMigrationBackupHook(
  createBackup: CreateBackupUseCase,
): (version: number) => Promise<void> {
  return async (version: number): Promise<void> => {
    const result = await createBackup.execute({
      mode: 'auto',
      targetName: `pre-migration-v${version}${BACKUP_EXTENSION}`,
    });
    if (!result.ok) {
      // Контракт hook'а TASK-024: наружу AppError — runner оборачивает в
      // STORAGE/MIGRATION_FAILED (cause, память main). Правилу only-throw-error
      // это объяснено (прецедент sqlite.ts/migration-runner.ts).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error;
    }
  };
}

// Реэкспорт для хендлера 073 (тип фазы прогресса — контракт contracts).
export type { BackupPhase };
