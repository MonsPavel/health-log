/**
 * TASK-045 §5/§9/§13/§14: SQLite-адаптер FTS-поиска заметок (порт NotesSearchPort,
 * ports/notes-search.ts) над FTS5 external-content индексом миграции v2
 * (shared/db/migrations/v2-fts.ts).
 *
 * ПУТИ ПОИСКА (§13 — «или/или», не смешиваются):
 *  1. MATCH (§9): санитизация toMatchQuery — пользовательский текст → безопасный
 *     MATCH-запрос: разбиение по пробелам, каждый токен в двойные кавычки (phrase),
 *     `"` внутри токена удаляется; спецсинтаксис FTS5 (NEAR(, *, OR) нейтрализуется
 *     кавычками — фраза из служебных символов не матчится, а не ошибка (§20 AC4:
 *     `test" OR 1=1` → пустой/безопасный результат). Пустой после санитизации запрос
 *     → [] БЕЗ обращения к FTS (§9: «пустой → пустой результат, не ошибка»).
 *  2. LIKE-fallback (§13): если MATCH вернул 0 и обрезанный запрос ≥2 символов →
 *     параметризованный `LIKE '%q%' ESCAPE '\'` c экранированием \%_ (§14) — подстрочный
 *     поиск поверх морфологического ограничения FTS5 (TD-IMP-3: «болел» находит
 *     «болела»).
 *
 * ДЕДУП (§2): результат собирается в Map по id — запись в выдаче один раз.
 * СОРТИРОВКА (§5 «не включено: ранжирование»): по времени desc, tie-break id desc —
 * как listByPeriod (TASK-026 §13).
 *
 * STATEMENTS (§15, прецедент sqlite-measurement-repository): SQL фиксирован —
 * prepared в конструкторе; параметр MATCH — всегда плейсхолдер (§14: никаких
 * конкатенаций пользовательского текста). Row-mapper строки → агрегат повторяет
 * sqlite-measurement-repository (§7): адаптеры не импортируют друг друга (матрица
 * арх. 03 §4), дублирование маппера — осознанная плата изоляции слоёв.
 *
 * ЛОГ (§18, прецедент адаптера TASK-026): logger инъекционный, по умолчанию no-op;
 * телеметрия вызова — в use case (§18 TASK-045), адаптер логирует только ошибки.
 */
import type Database from 'better-sqlite3';

import type { BpMeasurement, NotesSearchPort, NotesSearchQuery } from '../application/ports/notes-search.js';

/** Минимальная поверхность логгера адаптера (§18; матрица арх. 03 §4 — no-op в тестах). */
export interface NotesSearchLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** no-op логгер: тесты и вызовы без телеметрии. */
const noopLogger: NotesSearchLogger = { error() {} };

/**
 * MATCH-запрос: JOIN content-таблицы по rowid (external content — текст в
 * bp_measurement, §8); ORDER BY taken_at_utc DESC, id DESC (§5: не rank); LIMIT ?.
 */
const MATCH_SQL = `
  SELECT bm.id,
         bm.profile_id,
         bm.taken_at_utc,
         bm.tz_offset_minutes,
         bm.sys,
         bm.dia,
         bm.pulse,
         bm.irregular_pulse,
         bm.arm,
         bm.note,
         bm.source,
         bm.created_at_utc,
         bm.updated_at_utc
  FROM bp_measurement_fts
  JOIN bp_measurement bm ON bm.rowid = bp_measurement_fts.rowid
  WHERE bp_measurement_fts MATCH ?
  ORDER BY bm.taken_at_utc DESC, bm.id DESC
  LIMIT ?
`;

/** LIKE-подстрока по note (§13); ESCAPE '\' + экранирование \%_ в JS (§14). */
const LIKE_SQL = `
  SELECT id,
         profile_id,
         taken_at_utc,
         tz_offset_minutes,
         sys,
         dia,
         pulse,
         irregular_pulse,
         arm,
         note,
         source,
         created_at_utc,
         updated_at_utc
  FROM bp_measurement
  WHERE note LIKE @pattern ESCAPE '\\'
  ORDER BY taken_at_utc DESC, id DESC
  LIMIT @limit
`;

/** Строка bp_measurement как её отдаёт better-sqlite3 (формы SELECT выше). */
interface RawBpRow {
  id: string;
  profile_id: string;
  taken_at_utc: number;
  tz_offset_minutes: number;
  sys: number;
  dia: number;
  pulse: number | null;
  irregular_pulse: number;
  arm: string;
  note: string | null;
  source: string;
  created_at_utc: number;
  updated_at_utc: number;
}

/** Запрос ≥2 символов → разрешён LIKE-fallback (§13); считаем символы код-поинтами. */
const LIKE_MIN_QUERY_LENGTH = 2;

/**
 * Санитизация пользовательского ввода → безопасный MATCH-запрос (§9). Чистая функция:
 *  - trim + разбиение по пробельным;
 *  - `"` внутри токена удаляется (синтаксис фраз нейтрализован);
 *  - каждый токен оборачивается в двойные кавычки → FTS5 трактует его как фразу
 *    (служебные операторы OR/AND/NEAR, звёздочка и циркумфлекс внутри кавычек —
 *    просто текст);
 *  - токены, ставшие пустыми (состояли только из кавычек), отбрасываются;
 *  - пустой ввод → '' (адаптер вернёт [] без обращения к FTS).
 */
export function toMatchQuery(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .map((token) => token.replaceAll('"', ''))
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"`);
  return tokens.join(' ');
}

/** Экранирование спецсимволов LIKE (§14): \ → \\, % → \%, _ → \_. */
function escapeLikePattern(input: string): string {
  return input.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Row-mapper строка → агрегат (§7; структурное восстановление, прецедент TASK-026). */
function rowToAggregate(row: RawBpRow): BpMeasurement {
  const bp = { sys: row.sys, dia: row.dia };
  Object.defineProperty(bp, 'equals', {
    value: (other: BpMeasurement['bp']): boolean => other.sys === row.sys && other.dia === row.dia,
    enumerable: false,
  });
  return {
    id: row.id,
    profileId: row.profile_id,
    bp: bp as BpMeasurement['bp'],
    pulse: row.pulse === null ? undefined : (row.pulse as BpMeasurement['pulse']),
    irregularPulse: row.irregular_pulse !== 0,
    arm: row.arm as BpMeasurement['arm'],
    note: row.note ?? undefined,
    takenAt: { utcMs: row.taken_at_utc, tzOffsetMin: row.tz_offset_minutes },
    source: row.source as BpMeasurement['source'],
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

/**
 * SQLite-реализация NotesSearchPort (§5): MATCH → LIKE-fallback; дедуп по id;
 * сортировка desc. better-sqlite3 синхронный — методы оборачивают результат в
 * Promise.resolve (контракт порта асинхронный).
 */
export class NotesSearchAdapter implements NotesSearchPort {
  private readonly matchStmt: Database.Statement<[string, number], RawBpRow>;

  private readonly likeStmt: Database.Statement<[{ pattern: string; limit: number }], RawBpRow>;

  private readonly logger: NotesSearchLogger;

  constructor(db: Database.Database, options: { logger?: NotesSearchLogger } = {}) {
    this.matchStmt = db.prepare<[string, number], RawBpRow>(MATCH_SQL);
    this.likeStmt = db.prepare<[{ pattern: string; limit: number }], RawBpRow>(LIKE_SQL);
    this.logger = options.logger ?? noopLogger;
  }

  searchNotes(q: NotesSearchQuery): Promise<BpMeasurement[]> {
    return Promise.resolve(this.searchSync(q));
  }

  /** Тело поиска (§13): MATCH-путь → (0 результатов и ≥2 симв.) → LIKE-путь. */
  private searchSync(q: NotesSearchQuery): BpMeasurement[] {
    const query = q.query;
    const limit = q.limit;
    const matchQuery = toMatchQuery(query);
    if (matchQuery === '') {
      // §9: пустой/мусорный запрос — пустой результат, не ошибка; FTS не вызывается.
      return [];
    }

    try {
      const rows = this.matchStmt.all(matchQuery, limit);
      if (rows.length > 0) {
        return dedupById(rows);
      }
    } catch (error) {
      // Защитный путь: санитизация делает MATCH безопасным (§14), но непредвиденный
      // сбой БД — инфраструктурная ошибка: лог + повтор на LIKE-пути не маскирует
      // причину (наружу каркасу уйдёт APP/INTERNAL, §11), а пустой MATCH-результат
      // после сбоя дал бы честный LIKE-ответ без падения канала.
      this.logger.error('notes search MATCH failed, falling back to LIKE', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    // §13: fallback только при пустом MATCH и достаточно длинном запросе.
    if ([...query.trim()].length < LIKE_MIN_QUERY_LENGTH) {
      return [];
    }
    const pattern = `%${escapeLikePattern(query.trim())}%`;
    const rows = this.likeStmt.all({ pattern, limit });
    return dedupById(rows);
  }
}

/** Дедуп по записи (§2): Map по id сохраняет порядок SQL (сортировка desc). */
function dedupById(rows: RawBpRow[]): BpMeasurement[] {
  const byId = new Map<string, BpMeasurement>();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, rowToAggregate(row));
    }
  }
  return [...byId.values()];
}
