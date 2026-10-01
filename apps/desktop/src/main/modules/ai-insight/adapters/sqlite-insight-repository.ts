/**
 * TASK-087 §5: SQLite-адаптер порта InsightRepository над таблицей ai_summary
 * миграции v6 (прецедент SqliteScaleRepository TASK-051 / SqliteBpMeasurementRepository
 * TASK-026). Read-методы — без транзакций; save — один INSERT (строка атомарна сама
 * по себе, data_version НЕ bump-ит: резюме — КЭШ, не данные пользователя; счётчик
 * двигают только мутации дневника, арх. 04 §4).
 *
 * data_version читается из meta (та же строка, что сеет v1 и bump'ат мутации
 * measurement, §13) — прямой SELECT, без связки с чужим модулем (деpcruise:
 * adapters не импортируют чужие application).
 *
 * Скоуп профиля — в КАЖДОМ WHERE (принудительный скоуп, арх. 08 §3): hash не
 * глобальный ключ, поиск только внутри своего профиля.
 *
 * latestForPeriod (§12/ревью TASK-087): пресет/'all' сопоставляется по каноническому
 * period_param (границы пресета «двигаются» вместе с now момента генерации — точное
 * равенство границ между generate и latest недостижимо при любом сдвиге часов);
 * custom — по точным границам (+ period_param='custom'), они явные и стабильные.
 * Порядок (created_at_utc DESC, id DESC) LIMIT 1 — профиль доступа индекса v6.
 *
 * Ошибки (§7): наружу только AppError STORAGE/* (прецедент sqlite.ts TASK-022);
 * «нет записи» — undefined, не throw.
 */
import type { StatsPeriodParam } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type { EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type {
  InsightRepository,
  SummaryPeriodParam,
  SummaryRecord,
} from '../application/ports/insight-repository.js';

/**
 * Ключ i18n ошибки хранилища инсайтов (конвенция арх. 05 §29; тексты — TASK-101).
 * Код — существующий-generic STORAGE/FAILED (TASK-026: наружу только код, детали —
 * в params.operation и cause, §14); новый код ядра не заводится.
 */
export const STORAGE_FAILED_MESSAGE_KEY = 'errors.STORAGE_FAILED';

/** Чтение data_version из meta (та же строка, что v1/mutации measurement — §13). */
const READ_VERSION_SQL = "SELECT value FROM meta WHERE key = 'data_version'";

/** kind — константа 'summary' (CHECK v6); порт её не носит — таблица допускает только резюме (§5). */
const INSERT_SQL =
  'INSERT INTO ai_summary (id, profile_id, kind, period_param, period_start_utc, period_end_utc, ' +
  'context_hash, model_id, model_version, data_version, content_md, disclaimer_text, ' +
  'period_text, created_at_utc) ' +
  "VALUES (?, ?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const FIND_BY_HASH_SQL =
  'SELECT id, profile_id, period_param, period_start_utc, period_end_utc, context_hash, model_id, ' +
  'model_version, data_version, content_md, disclaimer_text, period_text, created_at_utc ' +
  'FROM ai_summary WHERE profile_id = ? AND context_hash = ?';

/** latest пресета/'all' — по каноническому параметру (см. шапку: границы «движутся»). */
const LATEST_BY_PARAM_SQL =
  'SELECT id, profile_id, period_param, period_start_utc, period_end_utc, context_hash, model_id, ' +
  'model_version, data_version, content_md, disclaimer_text, period_text, created_at_utc ' +
  'FROM ai_summary WHERE profile_id = ? AND period_param = ? ' +
  'ORDER BY created_at_utc DESC, id DESC LIMIT 1';

/** latest custom — по точным границам (явные utcMs renderer'а, стабильны) + 'custom'. */
const LATEST_BY_BOUNDS_SQL =
  'SELECT id, profile_id, period_param, period_start_utc, period_end_utc, context_hash, model_id, ' +
  'model_version, data_version, content_md, disclaimer_text, period_text, created_at_utc ' +
  "FROM ai_summary WHERE profile_id = ? AND period_param = 'custom' " +
  'AND period_start_utc = ? AND period_end_utc = ? ' +
  'ORDER BY created_at_utc DESC, id DESC LIMIT 1';

/** Строка таблицы (сырая форма SQL). */
interface SummaryRow {
  id: string;
  profile_id: string;
  period_param: string;
  period_start_utc: number;
  period_end_utc: number;
  context_hash: string;
  model_id: string;
  model_version: string;
  data_version: number;
  content_md: string;
  disclaimer_text: string;
  period_text: string;
  created_at_utc: number;
}

/** Защита от мусорного значения period_param в БД (NOT NULL, но не факт 'summary'-состав). */
function toPeriodParam(raw: string): SummaryPeriodParam {
  return raw === '7d' || raw === '30d' || raw === '90d' || raw === 'all' || raw === 'custom'
    ? raw
    : 'custom';
}

/** Маппинг строки → запись порта (плоская форма БД → VO §7). */
function toRecord(row: SummaryRow): SummaryRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    periodParam: toPeriodParam(row.period_param),
    period: { fromUtcMs: row.period_start_utc, toUtcMs: row.period_end_utc },
    contextHash: row.context_hash,
    modelId: row.model_id,
    modelVersion: row.model_version,
    dataVersion: row.data_version,
    contentMd: row.content_md,
    disclaimerText: row.disclaimer_text,
    periodText: row.period_text,
    createdAtUtc: row.created_at_utc,
  };
}

/**
 * Адаптер хранилища инсайтов (§5): вся память таблицы — внутри шифрованной БД
 * (§14); методы Promise-обёрнуты по контракту порта (§19 051).
 */
export class SqliteInsightRepository implements InsightRepository {
  private readonly db: EncryptedDatabase;

  constructor(db: EncryptedDatabase) {
    this.db = db;
  }

  /** Запись по кэш-ключу в скоупе профиля (§5); нет — undefined. */
  findByContextHash(profileId: string, contextHash: string): Promise<SummaryRecord | undefined> {
    try {
      const row = this.db.prepare(FIND_BY_HASH_SQL).get(profileId, contextHash) as
        SummaryRow | undefined;
      return Promise.resolve(row === undefined ? undefined : toRecord(row));
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('findByContextHash', cause));
    }
  }

  /** Сохранение записи (§5: только при done(ok) — вызывает use case). */
  save(record: SummaryRecord): Promise<void> {
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(
          record.id,
          record.profileId,
          record.periodParam,
          record.period.fromUtcMs,
          record.period.toUtcMs,
          record.contextHash,
          record.modelId,
          record.modelVersion,
          record.dataVersion,
          record.contentMd,
          record.disclaimerText,
          record.periodText,
          record.createdAtUtc,
        );
      return Promise.resolve();
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('save', cause));
    }
  }

  /**
   * Новейшая запись периода (§12): пресет/'all' — по каноническому параметру,
   * custom — по точным границам; порядок created_at_utc DESC (см. шапку).
   */
  latestForPeriod(profileId: string, period: StatsPeriodParam): Promise<SummaryRecord | undefined> {
    try {
      const row =
        typeof period === 'string'
          ? (this.db.prepare(LATEST_BY_PARAM_SQL).get(profileId, period) as SummaryRow | undefined)
          : (this.db
              .prepare(LATEST_BY_BOUNDS_SQL)
              .get(profileId, period.fromUtcMs, period.toUtcMs) as SummaryRow | undefined);
      return Promise.resolve(row === undefined ? undefined : toRecord(row));
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('latestForPeriod', cause));
    }
  }

  /** Очистка всех резюме (§8: wipe покрывает таблицу, кнопка — deleteAll). */
  deleteAll(): Promise<void> {
    try {
      this.db.prepare('DELETE FROM ai_summary').run();
      return Promise.resolve();
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('deleteAll', cause));
    }
  }

  /** Текущий data_version (§7): SELECT из meta; строка сеется v1 ('1'). */
  currentDataVersion(): Promise<number> {
    try {
      const row = this.db.prepare(READ_VERSION_SQL).get() as { value: string } | undefined;
      const version = row === undefined ? Number.NaN : Number(row.value);
      if (!Number.isInteger(version) || version < 0) {
        // Счётчик отсутствует/испорчен — не молча «0» (стейлс бы соврал), а честный отказ.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
        return Promise.reject(
          this.storageError('currentDataVersion', new Error('meta.data_version некорректен')),
        );
      }
      return Promise.resolve(version);
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('currentDataVersion', cause));
    }
  }

  /** Единая фабрика STORAGE/FAILED адаптера (прецедент TASK-026; cause — память main). */
  private storageError(operation: string, cause: unknown): AppError {
    return AppError.of('STORAGE/FAILED', STORAGE_FAILED_MESSAGE_KEY, { operation }, cause);
  }
}
