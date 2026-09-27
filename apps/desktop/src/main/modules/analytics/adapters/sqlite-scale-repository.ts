/**
 * TASK-051 §5/§9/§13/§14/§15: SQLite-адаптер порта ScaleRepository (application/
 * ports/scale-repository.ts) над таблицей reference_scale миграции v4 (shared/db/
 * migrations/v4-scales-events.ts). better-sqlite3 синхронный — Promise-обёртка
 * (контракт порта асинхронный; прецедент SettingsStore TASK-047).
 *
 * АКТИВНОСТЬ (§13): SELECT … WHERE activated_at_utc IS NOT NULL ORDER BY
 * activated_at_utc DESC LIMIT 1 — активная = max activated_at_utc на code;
 * неактивированные записи (NULL) активными не считаются; история версий хранится
 * с проставленным моментом активации, обнуления нет.
 *
 * ЗАПИСЬ (§9): INSERT с activated_at_utc NULL → activate отдельным UPDATE с
 * моментом из порта Clock (время в рантайме — только через инъекцию, §13 прецедент
 * миграции v1). SQLITE_CONSTRAINT_* (UNIQUE(code, version) — §8) → AppError
 * STORAGE/CONSTRAINT, остальное → STORAGE/FAILED — наружу только коды, детали в
 * cause (память main, §14; прецедент sqlite-measurement-repository TASK-026).
 *
 * STATEMENTS (§15): SQL фиксирован — prepared в конструкторе (§15 прецедент
 * TASK-026); именованные параметры — параметризованные запросы (§14).
 *
 * ЛОГ (§18): logger инъекционный (матрица арх. 03 §4 — адаптеры не импортируют
 * shared), боевой — createLogger('db') в контейнере, по умолчанию no-op; адаптер
 * логирует только ошибки записи (error) — чтение без логов (§15: один SELECT).
 */
import type Database from 'better-sqlite3';

import { AppError } from '@hl/kernel';

import type { Clock } from '@hl/kernel';

import type {
  ScaleRecord,
  ScaleRecordInput,
  ScaleRepository,
} from '../application/ports/scale-repository.js';

/** Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); тексты — TASK-101. */
export const STORAGE_CONSTRAINT_MESSAGE_KEY = 'errors.STORAGE_CONSTRAINT';
export const STORAGE_FAILED_MESSAGE_KEY = 'errors.STORAGE_FAILED';

/** Минимальная поверхность логгера адаптера (§18; HlLogger ей удовлетворяет). */
export interface ScaleRepositoryLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** no-op логгер: тесты и вызовы без телеметрии. */
const noopLogger: ScaleRepositoryLogger = {
  error() {},
};

/** §13: активная запись кода — max activated_at_utc среди активированных (LIMIT 1). */
const FIND_ACTIVE_SQL = `
  SELECT id, code, version, source_label, data_json, activated_at_utc
  FROM reference_scale
  WHERE code = ? AND activated_at_utc IS NOT NULL
  ORDER BY activated_at_utc DESC
  LIMIT 1
`;

/** Вставка новой версии: activated_at_utc NULL до явной активации (§5: insert → activate). */
const INSERT_SQL = `
  INSERT INTO reference_scale (id, code, version, source_label, data_json, activated_at_utc)
  VALUES (@id, @code, @version, @source_label, @data_json, NULL)
`;

/** Активация: момент — из Clock (инъекция времени, §13). */
const ACTIVATE_SQL =
  'UPDATE reference_scale SET activated_at_utc = @activated_at_utc WHERE id = @id';

/** Строка БД (snake_case) — сырой вид до маппинга в ScaleRecord. */
interface ScaleRow {
  readonly id: string;
  readonly code: string;
  readonly version: string;
  readonly source_label: string;
  readonly data_json: string;
  readonly activated_at_utc: number | null;
}

/** ROW-MAPPER (§7): snake_case колонок → camelCase записи порта. */
function toRecord(row: ScaleRow): ScaleRecord {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    sourceLabel: row.source_label,
    dataJson: row.data_json,
    activatedAtUtc: row.activated_at_utc,
  };
}

/** Маппинг ошибки записи в AppError (§9/§14 — прецедент sqlite-measurement-repository). */
function mapWriteError(error: unknown): AppError {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return AppError.of('STORAGE/CONSTRAINT', STORAGE_CONSTRAINT_MESSAGE_KEY, undefined, error);
  }
  return AppError.of('STORAGE/FAILED', STORAGE_FAILED_MESSAGE_KEY, undefined, error);
}

/** Опции конструктора (§19): Clock обязателен (activate), логгер — нет. */
export interface SqliteScaleRepositoryOptions {
  readonly clock: Clock;
  readonly logger?: ScaleRepositoryLogger;
}

/** SQLite-реализация ScaleRepository (§5). */
export class SqliteScaleRepository implements ScaleRepository {
  private readonly findActiveStmt: Database.Statement<[string], ScaleRow>;

  private readonly insertStmt: Database.Statement<{
    id: string;
    code: string;
    version: string;
    source_label: string;
    data_json: string;
  }>;

  private readonly activateStmt: Database.Statement<{ id: string; activated_at_utc: number }>;

  private readonly clock: Clock;

  private readonly logger: ScaleRepositoryLogger;

  constructor(db: Database.Database, options: SqliteScaleRepositoryOptions) {
    this.findActiveStmt = db.prepare<[string], ScaleRow>(FIND_ACTIVE_SQL);
    this.insertStmt = db.prepare(INSERT_SQL);
    this.activateStmt = db.prepare(ACTIVATE_SQL);
    this.clock = options.clock;
    this.logger = options.logger ?? noopLogger;
  }

  /** §13: активная запись кода или undefined; чтение без логов (§15: один SELECT на старт). */
  findActiveByCode(code: string): Promise<ScaleRecord | undefined> {
    const row = this.findActiveStmt.get(code);
    return Promise.resolve(row === undefined ? undefined : toRecord(row));
  }

  /** Вставка новой версии (§9): дубль UNIQUE(code,version) → STORAGE/CONSTRAINT (§8). */
  insert(input: ScaleRecordInput): Promise<void> {
    return Promise.resolve().then(() => {
      try {
        this.insertStmt.run({
          id: input.id,
          code: input.code,
          version: input.version,
          source_label: input.sourceLabel,
          data_json: input.dataJson,
        });
      } catch (error) {
        this.logger.error('scale repository: вставка не удалась', {
          code: input.code,
          version: input.version,
          cause: error instanceof Error ? error.message : String(error),
        });
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9, прецедент settings-store)
        throw mapWriteError(error);
      }
    });
  }

  /** Активация (§5): activated_at_utc = now Clock; мимо id — no-op (контракт порта). */
  activate(id: string): Promise<void> {
    return Promise.resolve().then(() => {
      try {
        this.activateStmt.run({ id, activated_at_utc: this.clock.nowMs() });
      } catch (error) {
        this.logger.error('scale repository: активация не удалась', {
          cause: error instanceof Error ? error.message : String(error),
        });
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9, прецедент settings-store)
        throw mapWriteError(error);
      }
    });
  }
}
