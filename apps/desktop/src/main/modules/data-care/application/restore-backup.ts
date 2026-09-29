/**
 * TASK-071 §5: use case RestoreBackup — восстановление из шифрованной копии:
 * валидация контейнера (magic → манифест zod → GCM-расшифровка паролем →
 * sha256(payload) == манифест) → план с предупреждениями → подтверждение
 * (второй вызов с confirmed=true) → замена БД → перезапуск приложения.
 *
 * ДВЕ ФАЗЫ (§7/§11 — против случайного двойного клика):
 *  - фаза 1 (confirmed: false) — ТОЛЬКО чтение: план {manifest, schemaDelta,
 *    warnings, currentCounts}; текущая БД не закрывается, страховка не создаётся;
 *  - фаза 2 (confirmed: true) — замена: merge-восстановления НЕТ (§5: замена,
 *    решение SRS UC-08).
 *
 * ПОРЯДОК execute (§8; каждый отказ ДО подмены не касается текущих данных, AC-2.5):
 *  pre-close (отказ здесь = чистая отмена, БД не тронута):
 *   1. переразбор контейнера (файл мог измениться между фазами) + манифест zod;
 *   2. schemaDelta: копия новее → BACKUP/DB_NEWER ДО закрытия («обновите
 *      приложение», EC-25; миграций «назад» нет);
 *   3. страховка (§8/§14): VACUUM INTO текущей БД во временный каталог →
 *      ШИФРОВАННЫЙ контейнер тем же паролем (auto-копия; открытый текст снапшота
 *      удаляется сразу после записи контейнера) → флаг-файл (запись до закрытия —
 *      сбой отменяет операцию чисто);
 *   4. closeCurrentDb (checkpoint + close — точка контейнера);
 *  post-close (ЛЮБОЙ сбой → откат из страховки, §8/AC-5):
 *   5. GCM-расшифровка копии + sha256 (точка мок-сбоя теста §19);
 *   6. удаление db/-wal/-shm → запись расшифрованного снапшота на место db;
 *   7. verifyDatabaseOpens (открытие подменённой БД — §8 «открытие копии упало
 *      после подмены» → откат) → relaunch (§9).
 *
 * РЕШЕНИЯ-ТРАКТОВКИ (документировано):
 *  - откат (§8) = расшифровка страховки тем же паролем: крипто-инфраструктура
 *    только что отработала на записи страховки — сбой отката практически
 *    невозможен; если всё же случился — каталог страховки в tmp СОХРАНЯЕТСЯ для
 *    ручного восстановления (TASK-101), наружу BACKUP/FAILED;
 *  - после удачного отката relaunch запланирован тоже (§9): соединение закрыто —
 *    приложение без БД неработоспособно; перезапуск стартует на возвращённых
 *    данных (AC-5 «данные работоспособны»);
 *  - копия с kdf id 'db-key' (авто-копия hook'а, машиносвязная) паролем не
 *    расшифровывается в принципе → BACKUP/INTEGRITY (cause объясняет вид копии);
 *  - точка расширения TASK-101 (§23): recovery-восстановление при повреждённой
 *    текущей БД переиспользует execute с пропуском plan-сравнения (параметр
 *    recovery) — здесь НЕ реализуется.
 *
 * Ошибки (§5/§13): наружу только AppError значением Result (прецедент 070):
 *  - BACKUP/DB_NEWER — копия новее текущей схемы (params {schemaVersion});
 *  - BACKUP/WRONG_PASSPHRASE — GCM-неудача (неверный пароль ИЛИ порча —
 *    криптографически неотличимы, текст сообщения покрывает оба, §14);
 *  - BACKUP/INTEGRITY — контейнер не разбирается (магия/манифест/не-JSON) или
 *    sha256 снапшота не сошёлся (AC-4);
 *  - BACKUP/FAILED — прочие сбои (ФС/шифрование), исход в cause (память main);
 *  - VALIDATION/FAILED — пустые file/passphrase команды (прецедент 070 §13).
 *
 * Безопасность (§14): пароль не логируется (redact-страховка логгера); rate-limit
 * не нужен (локальный файл, пользователь сам); страховка хранится ШИФРОВАННОЙ
 * (тот же пароль), путь tmp ОС; удаление — при успешном старте по флаг-файлу
 * (cleanupRestoreSafetyCopy; место вызова — старт приложения, подключение 073/101).
 *
 * Лог (§18): `restore plan` {file, schemaDelta, counts, currentCounts} →
 * `restore execute` → `restore success`; только basename файла (пути наружу не
 * идут) и никаких секретов.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { BACKUP_MANIFEST_SCHEMA, type BackupManifest } from '@hl/contracts';
import { AppError, type Clock, type Result } from '@hl/kernel';

import {
  BackupContainerFormatError,
  BackupIntegrityError,
  type BackupCrypto,
} from './ports/backup-crypto.js';
import type { BackupDatabase } from './ports/backup-database.js';
import type { FileOpQueue } from './file-op-queue.js';

/** Ключи i18n-каталога (конвенция арх. 05 §29 `errors.<КОД>`); тексты — TASK-073/101. */
export const RESTORE_DB_NEWER_MESSAGE_KEY = 'errors.BACKUP_DB_NEWER';
export const RESTORE_WRONG_PASSPHRASE_MESSAGE_KEY = 'errors.BACKUP_WRONG_PASSPHRASE';
export const RESTORE_INTEGRITY_MESSAGE_KEY = 'errors.BACKUP_INTEGRITY';
export const RESTORE_FAILED_MESSAGE_KEY = 'errors.BACKUP_FAILED';
/** Ключ каркасного кода валидации (contracts app-error-dto: errors.validation). */
const VALIDATION_MESSAGE_KEY = 'errors.validation';

/** Префикс tmp-каталогов страховки (§14; точка наблюдения чистки — тесты §19). */
const SAFETY_TMP_PREFIX = 'hl-restore-safety-';
/** Имя шифрованного контейнера страховки внутри tmp-каталога (§14: auto-копия). */
const SAFETY_CONTAINER_FILENAME = 'pre-restore.hlbackup';
/** Имя временного снапшота страховки (открытый текст — удаляется сразу после шифрования). */
const SAFETY_SNAPSHOT_FILENAME = 'current-snapshot.db';
/** Версия формы флаг-файла страховки (§14: удаление при успешном старте). */
const SAFETY_FLAG_VERSION = 1;
/** Версия формата контейнера страховки (= BACKUP_FORMAT_VERSION контракта §4). */
const BACKUP_FORMAT_VERSION = 1;

/**
 * sha256 расшифрованного снапшота не совпал с манифестом (AC-4): GCM прошёл
 * (пароль верен, байты аутентифицированы), но содержимое не то — порча,
 * пережившая GCM, или подделка с перевычисленным тегом. Внутренний тип use case:
 * маппится в BACKUP/INTEGRITY (не в WRONG_PASSPHRASE — в отличие от GCM-неудачи,
 * пароль здесь доказанно верен).
 */
class SnapshotShaMismatchError extends Error {
  constructor() {
    super('sha256 расшифрованного снапшота не совпал с манифестом (AC-4)');
    this.name = 'SnapshotShaMismatchError';
  }
}

/** Минимальная поверхность логгера use case (§18; прецедент CreateBackupLogger). */
export interface RestoreBackupLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Команда восстановления (§11: канал `backup/restore`, discriminated по confirmed). */
export interface RestoreBackupCommand {
  /** Путь контейнера копии (выбор пользователя — диалог 073). */
  readonly file: string;
  /** Пароль копии (§8). */
  readonly passphrase: string;
  /** false → план (фаза 1); true → замена + перезапуск (фаза 2, §7). */
  readonly confirmed: boolean;
}

/** Дельта схемы копии против текущей БД (§5/§13). */
export type RestoreSchemaDelta = 'equal' | 'older' | 'newer';

/** Коды предупреждений плана (§7): замена — всегда; старее — при older. */
export type RestoreWarningCode = 'replaces-current' | 'older-than-current';

/** План восстановления (§7): показывается пользователю ДО подтверждения. */
export interface RestorePlan {
  /** Манифест копии (валидирован zod, §5 «манифест zod?»). */
  readonly manifest: BackupManifest;
  /** Сравнение schema_version копии и текущей БД (§13: newer → отказ DB_NEWER). */
  readonly schemaDelta: RestoreSchemaDelta;
  /** Предупреждения (§7/§13): замена — всегда, даже при пустой текущей БД. */
  readonly warnings: readonly RestoreWarningCode[];
  /** Счётчики ТЕКУЩЕЙ БД (§5: «в копии 120, сейчас 350» — факт, не оценка). */
  readonly currentCounts: { readonly measurements: number };
}

/** Значение результата: план фазы 1 или факт запланированного перезапуска фазы 2. */
export type RestoreBackupResultValue =
  { readonly plan: RestorePlan } | { readonly restarting: true };

/** Зависимости use case (§5): подстановочные в тестах (§19). */
export interface RestoreBackupDeps {
  /** Открытая текущая БД (meta/counts до закрытия + VACUUM INTO страховки, §8). */
  readonly currentDb: BackupDatabase;
  /** Закрытие текущей БД (checkpoint + close — точка контейнера, §8). */
  readonly closeCurrentDb: () => void;
  /** Путь файла текущей БД (-wal/-shm выводятся конвенцией SQLite, §8). */
  readonly dbPath: string;
  /**
   * Проверка «подменённая БД открывается» (§8: открытие копии после подмены;
   * чужой ключ SQLCipher — честный сбой здесь → откат). Реализация контейнера —
   * openEncrypted(path, keyHex) + close (единственная точка открытия, TASK-022).
   */
  readonly verifyDatabaseOpens: (path: string) => void;
  /** Криптоконтейнер (арх. 02 §3.5: порт BackupCrypto). */
  readonly crypto: BackupCrypto;
  /** Логгер (§18) — категория db. */
  readonly logger: RestoreBackupLogger;
  /** Очередь файловых операций (§9 070 — сериализация с копиями/экспортами). */
  readonly queue: FileOpQueue;
  /**
   * Планировщик перезапуска (§9): боевая реализация контейнера —
   * `setTimeout(() => { app.relaunch(); app.exit(0); }, 500)` — ОТЛОЖЕННО, чтобы
   * ответ канала ушёл рендереру до выхода (деталь §9, зафиксировано).
   */
  readonly relaunch: () => void;
  /** Путь флаг-файла страховки (§14: удаление при успешном старте; userData). */
  readonly safetyFlagPath: string;
  /** Корень tmp-каталогов страховки (точка наблюдения тестов; по умолчанию os.tmpdir()). */
  readonly safetyTmpRoot?: string;
  /** Порт времени (манифест страховки; FixedClock в тестах, NFR-10). */
  readonly clock: Clock;
  /** Версия приложения (манифест страховки; bootstrap — app.getVersion()). */
  readonly appVersion: string;
}

/**
 * Use case восстановления из копии (§5). Один экземпляр на приложение (контейнер
 * TASK-027; регистрация канала — TASK-073).
 */
export class RestoreBackupUseCase {
  constructor(private readonly deps: RestoreBackupDeps) {}

  /** Выполняет фазу (§11); ошибки — значением Result, исключения не пересекают слои. */
  async execute(
    command: RestoreBackupCommand,
  ): Promise<Result<RestoreBackupResultValue, AppError>> {
    // План — только чтение (файл копии + meta текущей БД): без очереди.
    // Execute — файловая операция (страховка/подмена) — строго под FileOpQueue.
    return command.confirmed
      ? this.deps.queue.run(() => this.runExecute(command))
      : this.runPlan(command);
  }

  /** Фаза 1 (§5): план. Только чтение — текущая БД не закрывается. */
  private async runPlan(
    command: RestoreBackupCommand,
  ): Promise<Result<RestoreBackupResultValue, AppError>> {
    const startedAtMs = performance.now();
    try {
      const invalid = this.validateCommand(command);
      if (invalid !== undefined) {
        return { ok: false, error: invalid };
      }

      // Валидация контейнера (§5): разбор → манифест zod → ключ по записи kdf →
      // GCM → sha256. Ошибки маппятся mapContainerError (§5/§19).
      const manifest = await this.readValidatedManifest(command.file);
      const contentKey = await this.deps.crypto.contentKeyFor(manifest.kdf, {
        kind: 'passphrase',
        passphrase: command.passphrase,
      });
      const read = await this.deps.crypto.readContainer({
        containerPath: command.file,
        contentKey,
      });
      if (sha256Bytes(read.payload) !== manifest.dbSha256) {
        // AC-4: отказ целостности — расшифровка прошла, байты не те.
        throw new SnapshotShaMismatchError();
      }

      // Решение по схеме (§5/§13): newer → отказ «обновите приложение».
      const schemaDelta = this.resolveSchemaDelta(manifest);
      if (schemaDelta === 'newer') {
        return { ok: false, error: errDbNewer(manifest) };
      }

      const currentCounts = { measurements: countMeasurements(this.deps.currentDb) };
      const warnings: RestoreWarningCode[] =
        schemaDelta === 'older' ? ['replaces-current', 'older-than-current'] : ['replaces-current'];

      // §18: факты без путей (basename) и секретов (§14).
      this.deps.logger.info('restore plan', {
        file: basename(command.file),
        schemaDelta,
        counts: manifest.counts.measurements,
        currentCounts: currentCounts.measurements,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return {
        ok: true,
        value: { plan: { manifest, schemaDelta, warnings, currentCounts } },
      };
    } catch (error) {
      this.deps.logger.error('restoreBackup: отказ плана восстановления', {
        code: mapContainerError(error).code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: mapContainerError(error) };
    }
  }

  /** Фаза 2 (§5/§8): страховка → закрытие → подмена → проверка → перезапуск. */
  private async runExecute(
    command: RestoreBackupCommand,
  ): Promise<Result<RestoreBackupResultValue, AppError>> {
    const startedAtMs = performance.now();
    // Pre-close: любой отказ здесь — чистая отмена (текущая БД не тронута, AC-2).
    let safetyDir: string;
    let manifest: BackupManifest;
    let schemaDelta: RestoreSchemaDelta;
    try {
      const invalid = this.validateCommand(command);
      if (invalid !== undefined) {
        return { ok: false, error: invalid };
      }

      // 1. Переразбор контейнера (файл мог измениться между фазами) + манифест zod.
      manifest = await this.readValidatedManifest(command.file);

      // 2. Копия новее → отказ ДО закрытия текущей БД (AC-2: текущие данные работают).
      schemaDelta = this.resolveSchemaDelta(manifest);
      if (schemaDelta === 'newer') {
        return { ok: false, error: errDbNewer(manifest) };
      }

      // 3. Страховка (§8/§14): шифрованная auto-копия текущей БД тем же паролем.
      safetyDir = await this.createSafetyCopy(command.passphrase);
      this.deps.logger.info('restore execute', {
        file: basename(command.file),
        schemaDelta,
      });
    } catch (error) {
      this.deps.logger.error('restoreBackup: сбой восстановления (до закрытия БД)', {
        code: mapContainerError(error).code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: mapContainerError(error) };
    }

    // 4. Закрытие (checkpoint + close — §8); после этой точки любой сбой → откат.
    this.deps.closeCurrentDb();

    try {
      // 5. GCM-расшифровка копии + sha256 (точка мок-сбоя теста §19).
      const contentKey = await this.deps.crypto.contentKeyFor(manifest.kdf, {
        kind: 'passphrase',
        passphrase: command.passphrase,
      });
      const read = await this.deps.crypto.readContainer({
        containerPath: command.file,
        contentKey,
      });
      if (sha256Bytes(read.payload) !== manifest.dbSha256) {
        throw new SnapshotShaMismatchError();
      }

      // 6. Подмена (§8): файлы db/-wal/-shm удалены, снапшот на место db.
      this.removeDatabaseFiles();
      writeFileSync(this.deps.dbPath, read.payload);

      // 7. Открытие копии после подмены (§8) — чужой ключ/порча → откат.
      this.deps.verifyDatabaseOpens(this.deps.dbPath);
    } catch (replaceError) {
      // Откат-страховка (§8): текущая БД возвращена из шифрованной страховки.
      return this.rollbackFromSafety(safetyDir, command.passphrase, replaceError, startedAtMs);
    }

    // §18: успех; §9: перезапуск запланирован (реализация контейнера — отложенный
    // relaunch через 500 мс, чтобы ответ канала ушёл — деталь зафиксирована выше).
    this.deps.logger.info('restore success', {
      file: basename(command.file),
      schemaDelta,
      durationMs: Math.round(performance.now() - startedAtMs),
    });
    this.deps.relaunch();
    return { ok: true, value: { restarting: true } };
  }

  /** Валидация команды (§13): file и passphrase — непустые строки (прецедент 070). */
  private validateCommand(command: RestoreBackupCommand): AppError | undefined {
    if (command.file.trim().length === 0 || command.passphrase.trim().length === 0) {
      this.deps.logger.debug('restoreBackup: пустой файл/пароль команды');
      return AppError.of('VALIDATION/FAILED', VALIDATION_MESSAGE_KEY);
    }
    return undefined;
  }

  /**
   * Разбор заголовка контейнера + zod-валидация манифеста (§5 «манифест zod?»).
   * Форма/JSON → INTEGRITY; машиносвязная авто-копия (kdf db-key) паролем не
   * восстанавливается → INTEGRITY с объяснением в cause (решение см. в шапке).
   */
  private async readValidatedManifest(file: string): Promise<BackupManifest> {
    const header = await this.deps.crypto.readHeader({ containerPath: file });
    const parsed = BACKUP_MANIFEST_SCHEMA.safeParse(header.manifest);
    if (!parsed.success) {
      throw new BackupContainerFormatError('манифест копии не соответствует форме контракта (§7)');
    }
    if (parsed.data.kdf.id === 'db-key') {
      throw new BackupContainerFormatError(
        'копия зашифрована ключом БД (авто-копия hook’а миграций, машиносвязная) — паролем не восстанавливается',
      );
    }
    return parsed.data;
  }

  /** Дельта схемы (§5/§13): schema_version копии против текущей БД. */
  private resolveSchemaDelta(manifest: BackupManifest): RestoreSchemaDelta {
    const current = readSchemaVersion(this.deps.currentDb);
    if (manifest.schemaVersion > current) {
      return 'newer';
    }
    return manifest.schemaVersion < current ? 'older' : 'equal';
  }

  /**
   * Страховка (§8/§14): VACUUM INTO текущей БД (ещё открыта) → шифрованный
   * контейнер тем же паролем (свежая соль — независимый контейнер) → флаг-файл.
   * Открытый текст снапшота удаляется сразу после записи контейнера (§14: ничего
   * незашифрованного на диске не остаётся). Ошибка — чистая отмена: каталог
   * страховки удаляется, текущая БД не тронута (исход пробрасывается).
   */
  private async createSafetyCopy(passphrase: string): Promise<string> {
    const safetyDir = mkdtempSync(join(this.deps.safetyTmpRoot ?? tmpdir(), SAFETY_TMP_PREFIX));
    try {
      const snapshotPath = join(safetyDir, SAFETY_SNAPSHOT_FILENAME);
      // Кавычки пути экранируются удвоением (SQL-литерал; прецедент 070).
      const escaped = snapshotPath.replace(/'/g, "''");
      this.deps.currentDb.exec(`VACUUM INTO '${escaped}'`);

      const { kdf, contentKey } = await this.deps.crypto.prepareKey({
        kind: 'passphrase',
        passphrase,
      });
      const safetyManifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        schemaVersion: readSchemaVersion(this.deps.currentDb),
        appVersion: this.deps.appVersion,
        createdAtUtc: this.deps.clock.nowMs(),
        counts: { measurements: countMeasurements(this.deps.currentDb) },
        dbSha256: await sha256File(snapshotPath),
        kdf,
      };
      await this.deps.crypto.writeContainer({
        manifestJson: Buffer.from(JSON.stringify(safetyManifest), 'utf8'),
        contentKey,
        snapshotPath,
        destinationPath: join(safetyDir, SAFETY_CONTAINER_FILENAME),
      });
      // Открытый текст снапшота больше не нужен — байты уже в контейнере (§14).
      unlinkSync(snapshotPath);

      // Флаг-файл (§14) — запись ДО закрытия БД: сбой записи отменяет операцию
      // чисто (каталог страховки удалён вызывающим catch, данные не тронуты).
      mkdirSync(dirname(this.deps.safetyFlagPath), { recursive: true });
      writeFileSync(
        this.deps.safetyFlagPath,
        JSON.stringify({
          v: SAFETY_FLAG_VERSION,
          dir: safetyDir,
          createdAtUtc: safetyManifest.createdAtUtc,
        }),
      );
      return safetyDir;
    } catch (error) {
      rmSync(safetyDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Удаляет файлы db/-wal/-shm перед подменой (§8; БД закрыта, дескрипторов нет). */
  private removeDatabaseFiles(): void {
    for (const path of [this.deps.dbPath, `${this.deps.dbPath}-wal`, `${this.deps.dbPath}-shm`]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }

  /**
   * Откат (§8/AC-5): подмена не удалась — текущая БД возвращается из шифрованной
   * страховки (тот же пароль), открытие проверяется; relaunch запланирован —
   * приложение стартует на возвращённых данных (решение в шапке). Наружу —
   * код исходного сбоя (mapContainerError).
   */
  private async rollbackFromSafety(
    safetyDir: string,
    passphrase: string,
    replaceError: unknown,
    startedAtMs: number,
  ): Promise<Result<RestoreBackupResultValue, AppError>> {
    const failed = mapContainerError(replaceError);
    try {
      const containerPath = join(safetyDir, SAFETY_CONTAINER_FILENAME);
      const manifest = await this.readValidatedManifest(containerPath);
      const contentKey = await this.deps.crypto.contentKeyFor(manifest.kdf, {
        kind: 'passphrase',
        passphrase,
      });
      const read = await this.deps.crypto.readContainer({ containerPath, contentKey });
      this.removeDatabaseFiles();
      writeFileSync(this.deps.dbPath, read.payload);
      this.deps.verifyDatabaseOpens(this.deps.dbPath);

      this.deps.logger.error('restoreBackup: восстановление не удалось, текущая БД возвращена', {
        code: failed.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      this.deps.relaunch();
      return { ok: false, error: failed };
    } catch (rollbackError) {
      // Сбой отката — крайний случай (см. шапку): каталог страховки СОХРАНЯЕТСЯ
      // в tmp для ручного восстановления (TASK-101), наружу BACKUP/FAILED.
      this.deps.logger.error('restoreBackup: откат не удался, страховка сохранена в tmp', {
        code: 'BACKUP/FAILED',
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return {
        ok: false,
        error: AppError.of(
          'BACKUP/FAILED',
          RESTORE_FAILED_MESSAGE_KEY,
          undefined,
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        ),
      };
    }
  }
}

/**
 * Удаляет страховку по флаг-файлу (§14: «удаление при успешном старте по
 * флаг-файлу»): каталог tmp + сам флаг. Вызывается при успешном старте приложения
 * (подключение — 073/101); сбой не должен валить старт — best-effort, boolean.
 */
export function cleanupRestoreSafetyCopy(flagPath: string): boolean {
  if (!existsSync(flagPath)) {
    return false;
  }
  try {
    const flag = JSON.parse(readFileSync(flagPath, 'utf8')) as { dir?: unknown };
    if (typeof flag.dir === 'string' && flag.dir.length > 0) {
      rmSync(flag.dir, { recursive: true, force: true });
    }
    unlinkSync(flagPath);
    return true;
  } catch {
    // Битый флаг/занятый файл — страховка остаётся (ОС подчистит tmp), старт живёт.
    return false;
  }
}

/** Маппинг исходов разбора контейнера в коды BACKUP/* (§5; детали — cause, §14). */
function mapContainerError(error: unknown): AppError {
  if (error instanceof BackupContainerFormatError || error instanceof SnapshotShaMismatchError) {
    // Не копия (магия/манифест/JSON/запись kdf) или байты не сошлись с манифестом.
    return AppError.of('BACKUP/INTEGRITY', RESTORE_INTEGRITY_MESSAGE_KEY, undefined, error);
  }
  if (error instanceof BackupIntegrityError) {
    // GCM-неудача: неверный пароль или порча — криптографически неотличимы (§14);
    // текст messages.BACKUP_WRONG_PASSPHRASE покрывает обе причины.
    return AppError.of(
      'BACKUP/WRONG_PASSPHRASE',
      RESTORE_WRONG_PASSPHRASE_MESSAGE_KEY,
      undefined,
      error,
    );
  }
  // Прочее (ФС: ENOENT/ENOSPC; TypeError контракта вызова) — сбой операции.
  return AppError.of('BACKUP/FAILED', RESTORE_FAILED_MESSAGE_KEY, undefined, error);
}

/** Ошибка «копия новее» (§5/§13): params для текста «копия схемы v{N}» (§16-17). */
function errDbNewer(manifest: BackupManifest): AppError {
  return AppError.of('BACKUP/DB_NEWER', RESTORE_DB_NEWER_MESSAGE_KEY, {
    schemaVersion: manifest.schemaVersion,
  });
}

/** Потоковый SHA-256 файла (hex, lowercase; прецедент 070 — страховка на диск). */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** SHA-256 буфера (hex, lowercase; payload в памяти — §15 ~20 МБ). */
function sha256Bytes(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * schema_version из meta (§5; свежая БД без meta — 0; прецедент
 * readSchemaVersion migration-runner.ts / create-backup.ts).
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

/** COUNT измерений текущей БД (§5/§13); таблицы ещё нет — 0 (прецедент 070). */
function countMeasurements(db: BackupDatabase): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM bp_measurement').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}
