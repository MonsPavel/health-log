/**
 * TASK-047 §5/§9/§14/§15: SQLite-адаптер порта SettingsStorePort (application/ports/
 * settings-store.ts) над таблицей app_setting миграции v3 (shared/db/migrations/
 * v3-app-setting.ts). better-sqlite3 синхронный — get синхронен, set оборачивается в
 * Promise (контракт порта асинхронный; прецедент NotesSearchAdapter TASK-045).
 *
 * ЧТЕНИЕ (§14 — zod-валидация при каждом чтении): JSON.parse → schema.safeParse;
 * повреждённый JSON или значение вне схемы → undefined + warn (§20 AC3 «без креша»);
 * ключа нет → undefined тихо (нормальный случай первого запуска — дефолты сервиса).
 *
 * ЗАПИСЬ (§9): UPSERT по PK — строка документа одна; updated_at_utc — из порта Clock
 * (время в рантайме — только через инъекцию, §13 прецедент миграции v1). Отказ SQL →
 * AppError STORAGE/FAILED (STORAGE/CONSTRAINT в KV-хранилище недостижим: PK-конфликт
 * разрешает UPSERT, NOT NULL гарантирован формой вызова) — наружу только коды, детали
 * в cause (§14, прецедент sqlite-measurement-repository).
 *
 * STATEMENTS (§15): SQL фиксирован — prepared в конструкторе (§15 прецедент TASK-026);
 * параметризованные запросы (§14).
 *
 * ЛОГ (§18): logger инъекционный (матрица арх. 03 §4 — адаптеры не импортируют
 * shared), боевой — createLogger('db') в контейнере, по умолчанию no-op; адаптер
 * логирует только повреждения значения (warn) и ошибки записи (error), значения
 * ключей в лог не идут.
 */
import type Database from 'better-sqlite3';
import type { ZodType } from 'zod';

import { AppError } from '@hl/kernel';

import type { Clock } from '@hl/kernel';

import type { SettingsStorePort } from '../application/ports/settings-store.js';

/** Ключ i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); текст — TASK-101. */
export const STORAGE_FAILED_MESSAGE_KEY = 'errors.STORAGE_FAILED';

/** Минимальная поверхность логгера адаптера (§18; HlLogger ей удовлетворяет). */
export interface SettingsStoreLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** no-op логгер: тесты и вызовы без телеметрии. */
const noopLogger: SettingsStoreLogger = {
  warn() {},
  error() {},
};

const GET_SQL = 'SELECT value_json FROM app_setting WHERE key = ?';

/** UPSERT (§9): строка ключа обновляется целиком; updated_at_utc — момент записи. */
const UPSERT_SQL = `
  INSERT INTO app_setting (key, value_json, updated_at_utc) VALUES (@key, @value_json, @updated_at_utc)
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_utc = excluded.updated_at_utc
`;

/** Опции конструктора (§19): Clock обязателен для боевого пути, логгер — нет. */
export interface SettingsStoreOptions {
  readonly clock: Clock;
  readonly logger?: SettingsStoreLogger;
}

/** SQLite-реализация SettingsStorePort (§5). */
export class SettingsStore implements SettingsStorePort {
  private readonly getStmt: Database.Statement<[string], { value_json: string }>;

  private readonly upsertStmt: Database.Statement<{
    key: string;
    value_json: string;
    updated_at_utc: number;
  }>;

  private readonly clock: Clock;

  private readonly logger: SettingsStoreLogger;

  constructor(db: Database.Database, options: SettingsStoreOptions) {
    this.getStmt = db.prepare<[string], { value_json: string }>(GET_SQL);
    this.upsertStmt = db.prepare(UPSERT_SQL);
    this.clock = options.clock;
    this.logger = options.logger ?? noopLogger;
  }

  get<T>(key: string, schema: ZodType<T>): T | undefined {
    const row = this.getStmt.get(key);
    if (row === undefined) {
      return undefined; // первый запуск/новый ключ — дефолты сервиса (§5), не warn
    }
    let raw: unknown;
    try {
      raw = JSON.parse(row.value_json) as unknown;
    } catch (cause) {
      // §5/§20 AC3: повреждённый JSON — дефолт (сервис) + warn, без креша.
      this.logger.warn('settings store: повреждённый JSON значения', { key, cause });
      return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // §14: значение вне схемы (полу-повреждение, дрейф версии) — как повреждённое.
      this.logger.warn('settings store: значение не прошло валидацию схемы', {
        key,
        cause: parsed.error.message,
      });
      return undefined;
    }
    return parsed.data;
  }

  /** Запись (§9): async-метод — синхронный сбой better-sqlite3 превращается в
   *  Promise-rejection (контракт порта асинхронный, §19). Отказ SQL → AppError
   *  STORAGE/FAILED: наружу только код, причина в cause (§14). */
  async set(key: string, valueJson: string): Promise<void> {
    try {
      this.upsertStmt.run({
        key,
        value_json: valueJson,
        updated_at_utc: this.clock.nowMs(),
      });
    } catch (error) {
      this.logger.error('settings store: запись не удалась', {
        cause: error instanceof Error ? error.message : String(error),
      });
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9, прецедент sqlite-measurement-repository)
      throw AppError.of('STORAGE/FAILED', STORAGE_FAILED_MESSAGE_KEY, undefined, error);
    }
  }
}
