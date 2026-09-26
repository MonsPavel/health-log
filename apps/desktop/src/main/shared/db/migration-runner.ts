/**
 * TASK-024 §2/§5: migration runner — forward-only миграции по `meta.schema_version`.
 *
 * ПОРЯДОК СТАРТА БД (§9, документируется здесь): openEncrypted → runner.migrate() →
 * готово. Миграции выполняются до открытия UI; сбой → краш старта с кодом
 * STORAGE/MIGRATION_FAILED → recovery-экран подхватит (TASK-101; отказы — EC-14).
 *
 * Контракт (§5/§8/§13):
 *  - таблица `meta (key TEXT PK, value TEXT NOT NULL)` создаётся runner'ом до первой
 *    миграции вместе с ключом `schema_version` (стартовое значение «0»); ключ
 *    `data_version` runner не трогает — его инициирует TASK-025 (=1);
 *  - применяются все миграции реестра с version > текущей, строго по возрастанию
 *    версий (реестр может быть передан в произвольном порядке); каждая миграция —
 *    ОДНА транзакция (BEGIN…COMMIT): DDL миграции + обновление schema_version;
 *  - DDL в SQLite транзакционен (ключевое преимущество, §4/§13): сбой внутри
 *    миграции → ROLLBACK — полусозданной схемы не остаётся (проверено тестом §19/§20);
 *  - повторный запуск при актуальной версии — no-op: hook не вызывается (§13);
 *  - hook снапшота `beforeMigration(version)` вызывается РОВНО один раз перед каждой
 *    применяемой миграцией, до её DDL (§13/§19 — порядок); интерфейс здесь,
 *    реализация (VACUUM INTO + шифрование) — TASK-070.
 *
 * Безопасность (§14): миграции выполняются над зашифрованной БД, открытой с ключом;
 * hook снапшота ОБЯЗАН сохранять шифрование копии (требование к TASK-070 — см.
 * комментарий в типе BeforeMigrationHook).
 *
 * Ошибки (§5/§20): наружу только AppError (прецедент обёртки TASK-022, §7/§13):
 *  - сбой hook'а или миграции → STORAGE/MIGRATION_FAILED, params {version},
 *    исходная ошибка в cause (память main, §14);
 *  - schema_version БД больше известной реестру → STORAGE/DB_NEWER_THAN_APP —
 *    «обновите приложение» (EC-25, §5 «будущая работа» — включено сразу).
 *
 * Лог (§18, категория db): `migrating v{N-1}→v{N}` перед каждой миграцией,
 * `migrated to v{N}` после; no-op — debug-факт без миграций.
 */
import { AppError } from '@hl/kernel';

import { createLogger } from '../logger/logger.js';

import type { EncryptedDatabase } from './sqlite.js';

/** Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); тексты — TASK-101. */
export const STORAGE_MIGRATION_FAILED_MESSAGE_KEY = 'errors.STORAGE_MIGRATION_FAILED';
export const STORAGE_DB_NEWER_THAN_APP_MESSAGE_KEY = 'errors.STORAGE_DB_NEWER_THAN_APP';

/**
 * Hook снапшота перед миграцией (§5): асинхронный — реализация TASK-070 делает
 * VACUUM INTO + шифрование копии (§15: секунды на больших БД). ТРЕБОВАНИЕ К
 * TASK-070 (§14): снапшот ОБЯЗАН сохранять шифрование — копия зашифрованной БД не
 * может писаться на диск в открытом виде. Сбой hook'а останавливает миграцию ДО
 * DDL (тот же контракт ошибки STORAGE/MIGRATION_FAILED — автокопия безнадёжна,
 * применять схему без копии запрещено, арх. 04 §5).
 */
export type BeforeMigrationHook = (version: number) => Promise<void>;

/** Дефолтный hook (§5: no-op, заменяется TASK-070). */
const noopHook: BeforeMigrationHook = () => Promise.resolve();

/** Одна миграция (§5): чистая функция над Database — никаких чтений ФС/сети (§7). */
export interface Migration {
  /** Целевая версия схемы (после применения up): целое число ≥ 1. */
  readonly version: number;
  /** DDL-шаг миграции: выполняется внутри транзакции runner'а. */
  readonly up: (db: EncryptedDatabase) => void;
}

export interface MigrationRunnerOptions {
  /** Реестр миграций (пополается задачами 025+; для приложения — MIGRATIONS из migrations/index.ts). */
  readonly migrations: readonly Migration[];
  /** Hook снапшота; по умолчанию — no-op (§5). */
  readonly beforeMigration?: BeforeMigrationHook;
}

/** Стартовое значение schema_version на свежей БД (§8: 0 = миграций не было). */
const SCHEMA_VERSION_FRESH = 0;
/** Ключ версии схемы в meta (§8; data_version runner не трогает — его инициирует TASK-025). */
const SCHEMA_VERSION_KEY = 'schema_version';

/** Логгер категории db (§18). */
const dbLog = createLogger('db');

/** Мета-таблица создаётся runner'ом до первой миграции (§8). */
const ENSURE_META_SQL =
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n' +
  `INSERT OR IGNORE INTO meta (key, value) VALUES ('${SCHEMA_VERSION_KEY}', '${SCHEMA_VERSION_FRESH}');`;

/**
 * Запись schema_version внутри транзакции миграции (§5: обновление в той же
 * транзакции): UPSERT — строка может отсутствовать (свежая meta, ключ удалён
 * извне), а отсутствие «schema_version» не должно молча пропускать запись версии.
 */
const SET_SCHEMA_VERSION_SQL =
  `INSERT INTO meta (key, value) VALUES ('${SCHEMA_VERSION_KEY}', ?)` +
  ' ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/** Читает текущую версию схемы (один SELECT, §15). */
function readSchemaVersion(db: EncryptedDatabase): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = '${SCHEMA_VERSION_KEY}'`).get() as
    { value: string } | undefined;
  if (row === undefined) {
    return SCHEMA_VERSION_FRESH;
  }
  // Значение, не являющееся неотрицательным целым, трактуется как «миграций не
  // было»: переприменение миграций наткнётся на существующие объекты и даст честный
  // STORAGE/MIGRATION_FAILED с cause — вместо тихого пропуска схемы.
  return /^\d+$/.test(row.value) ? Number(row.value) : SCHEMA_VERSION_FRESH;
}

/** Максимальная версия, известная реестру (реестр уже отсортирован, §5). */
function maxKnownVersion(sorted: readonly Migration[]): number {
  const last = sorted.at(-1);
  return last === undefined ? SCHEMA_VERSION_FRESH : last.version;
}

/**
 * Runner forward-only миграций (§5). Создаётся один раз на старте приложения с
 * реестром MIGRATIONS и hook'ом снапшота (реестр и hook — зависимости приложения,
 * поэтому в конструкторе, а не в состоянии модуля).
 */
export class MigrationRunner {
  /** Реестр по возрастанию версий — независим от порядка передачи (§5). */
  private readonly sorted: readonly Migration[];

  private readonly beforeMigration: BeforeMigrationHook;

  constructor(options: MigrationRunnerOptions) {
    const sorted = [...options.migrations].sort((a, b) => a.version - b.version);
    // Нарушение контракта реестра — программная ошибка: синхронный TypeError в
    // точке вызова (dev-контракт, прецедент assertKeyHex TASK-022 §7).
    let previous: Migration | undefined;
    for (const migration of sorted) {
      const duplicate = previous !== undefined && previous.version === migration.version;
      if (!Number.isInteger(migration.version) || migration.version < 1 || duplicate) {
        throw new TypeError(
          `MigrationRunner: версия миграции должна быть целым числом ≥ 1 без дубликатов, получено version=${String(migration.version)} (нарушение контракта реестра — программная ошибка, TASK-024 §5)`,
        );
      }
      previous = migration;
    }
    this.sorted = sorted;
    this.beforeMigration = options.beforeMigration ?? noopHook;
  }

  /**
   * Приводит схему БД к актуальной версии (§5). Идемпотентно: при актуальной версии
   * — no-op без вызова hook'а (§13); hook — один раз перед каждой применяемой
   * миграцией, до её DDL (§13/§19).
   */
  async migrate(db: EncryptedDatabase): Promise<void> {
    db.exec(ENSURE_META_SQL);
    const current = readSchemaVersion(db);
    const knownMax = maxKnownVersion(this.sorted);
    if (current > knownMax) {
      // EC-25 (§5): БД записана более новой версией приложения — данные не трогаем.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §7, прецедент sqlite.ts)
      throw AppError.of('STORAGE/DB_NEWER_THAN_APP', STORAGE_DB_NEWER_THAN_APP_MESSAGE_KEY, {
        version: current,
      });
    }
    let applied = current;
    for (const migration of this.sorted) {
      if (migration.version <= current) {
        continue;
      }
      dbLog.info(`migrating v${applied}→v${migration.version}`, {
        from: applied,
        to: migration.version,
      });
      try {
        // Hook снапшота — строго до транзакции DDL (§13: порядок hook → DDL, §19 п. 3).
        await this.beforeMigration(migration.version);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §7, прецедент sqlite.ts)
        throw AppError.of(
          'STORAGE/MIGRATION_FAILED',
          STORAGE_MIGRATION_FAILED_MESSAGE_KEY,
          { version: migration.version },
          error,
        );
      }
      this.apply(db, migration);
      applied = migration.version;
      dbLog.info(`migrated to v${migration.version}`, { version: migration.version });
    }
    if (applied === current) {
      // Идемпотентность (§13): no-op — ни hook'а, ни логов миграций; только debug-факт.
      dbLog.debug('schema up to date', { version: current });
    }
  }

  /**
   * Применяет одну миграцию в транзакции (§5): BEGIN…COMMIT, DDL внутрь; сбой →
   * ROLLBACK → STORAGE/MIGRATION_FAILED с номером версии (§20). DDL в SQLite
   * транзакционен — после ROLLBACK схема гарантированно на предыдущей версии (§13).
   */
  private apply(db: EncryptedDatabase, migration: Migration): void {
    try {
      db.exec('BEGIN');
      migration.up(db);
      // Обновление schema_version — в той же транзакции (§5): «схема+версия» атомарны.
      db.prepare(SET_SCHEMA_VERSION_SQL).run(String(migration.version));
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Транзакция уже закрыта (сбой COMMIT) — откатывать нечего, важнее cause.
      }
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §7, прецедент sqlite.ts)
      throw AppError.of(
        'STORAGE/MIGRATION_FAILED',
        STORAGE_MIGRATION_FAILED_MESSAGE_KEY,
        { version: migration.version },
        error,
      );
    }
  }
}
