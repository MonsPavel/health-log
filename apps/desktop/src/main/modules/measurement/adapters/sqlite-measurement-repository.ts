/**
 * TASK-026 §2/§5: SQLite-адаптер порта BpMeasurementRepository (TASK-021) над
 * better-sqlite3-multiple-ciphers (SQLCipher-стек TASK-022): CRUD + listByPeriod
 * с фильтрами; каждая мутация — транзакция «запись + bump meta.data_version»
 * (§13, FR-5.7) — механика бейджа «данные изменились» и инвалидации кэшей.
 * TASK-030 §7/§8: + countByPeriod — COUNT по тем же фильтрам (total списка).
 *
 * РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ (§12): адаптер знает про БД, события — не про него.
 * Импорта EventBus здесь НЕТ (grep-критерий §20): `data:versionBumped` публикует
 * use case (TASK-029), а не адаптер.
 *
 * МУТАЦИИ КАК ТРАНЗАКЦИИ (§5/§13/§15): statements INSERT/UPDATE/DELETE и bump
 * готовятся в конструкторе ОДИН РАЗ (требование better-sqlite3, §15) и исполняются
 * внутри `db.transaction` (§13: сбой → полный ROLLBACK — проверяется fail-point
 * тестом §19.8). Порядок в транзакции: (1) row-statement, (2) fail-point,
 * (3) `changes === 0` → MEASUREMENT/NOT_FOUND без бампа (мутация неуспешна —
 * «+1 за успешную», §13), (4) bump data_version. Read-методы — без транзакций (§5).
 *
 * FAIL-POINT (§13, принятый механизм, задокументирован): опция конструктора
 * `failAfterFirstStatementForTesting` — только для тестов; после исполнения первого
 * statement транзакции адаптер бросает синтетическую ошибку, имитируя краш между
 * записью строки и bump'ом версии. Так интеграционный тест доказывает ПОЛНЫЙ
 * rollback (записи нет, версия прежняя), не подменяя statements (§13: «инъекция
 * fail-point в конструкторе... Принять этот механизм, задокументировать»).
 *
 * ОШИБКИ (§9/§14): наружу только коды AppError, детали в cause (память main):
 * SQLITE_CONSTRAINT_* (UNIQUE/NOT NULL/FK/CHECK) → STORAGE/CONSTRAINT, остальное
 * → STORAGE/FAILED. Read-методы контрактом ошибок не определяют (TASK-021 §7).
 *
 * profileId-СКОУП (§14, арх. 08 §3): profile_id входит в каждый запрос, где его
 * даёт порт — INSERT берёт m.profileId, UPDATE фильтрует `WHERE id AND profile_id`
 * (чужая запись → changes=0 → NOT_FOUND), listByPeriod — обязательный q.profileId
 * (assert — синхронный TypeError, паритет с fake TASK-021 §20). getById/delete по
 * порту получают только id (глобально уникальный uuid v7) — скоупить нечем; это
 * ограничение контракта TASK-021, не адаптера.
 *
 * ROW-MAPPER (§7): `irregular_pulse` 0/1 ↔ boolean; `pulse`/`note` NULL ↔ undefined;
 * Instant ↔ пара колонок (taken_at_utc, tz_offset_minutes). Агрегат восстанавливается
 * СТРУКТУРНО: матрица арх. 03 §4 разрешает адаптерам только application-порты своего
 * модуля — класс BpMeasurement (приватный конструктор, TASK-017) сюда не импортируется,
 * порт отдаёт его как тип; публичная поверхность агрегата — набор readonly-полей, а
 * TypeScript структурен, поэтому строка БД собирается в объект, точный по типам.
 * Единственный метод поверхности — BloodPressure.equals — доставляется маппером с
 * семантикой VO (равенство по полям), non-enumerable: toEqual контрактного набора
 * сравнивает собственные поля данных, а не метод (TASK-021 §19.1). Бренд пульса и
 * строковые union (arm/source) восстанавливаются приведением типов: значения
 * записаны доменом и страхуются CHECK'ами v1 (TASK-025 §8).
 *
 * Drizzle (§4/§5 — фиксированное решение): описание bp_measurement — типобезопасное
 * ЗЕРКАЛО v1-схемы (DDL не генерируется — схему создаёт миграция TASK-025, §8);
 * WHERE listByPeriod собирается Drizzle query-builder'ом (QueryBuilder из
 * drizzle-orm/sqlite-core: драйверо-агностик — в рантайме импортирует только
 * sqlite-core, нативный better-sqlite3 не нужен, форк TASK-022 остаётся единственным
 * нативным модулем) и исполняется подготовленным statement'ом (toSQL → prepare).
 * Остальные statements — сырые с именованными параметрами (те же гарантии §14):
 * фиксированный SQL под prepared statements (§15). utcMs остаётся number — безопасно
 * до 8.6e15 мс (§22; better-sqlite3 по умолчанию не включает safeIntegers).
 *
 * ЛОГ (§18): мутации — debug (метод, durationMs, без значений — PHI-правило);
 * ошибки — error с машинным кодом. Логгер инъекционный (матрица арх. 03 §4:
 * adapters не импортируют shared — прецедент safe-storage-key-vault TASK-023):
 * боевой — createLogger('db') в контейнере (TASK-027), по умолчанию no-op (тесты).
 *
 * БУДУЩАЯ РАБОТА (§5/§23): batch-вставки импорта — один transaction вокруг N add;
 * статистика (TASK-052) — raw SQL рядом; read-реплики — не до NFR-9 (TD-8).
 */
import { performance } from 'node:perf_hooks';

import { and, desc, eq, gte, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type Database from 'better-sqlite3';

import { AppError, err, ok, type Instant, type Result } from '@hl/kernel';

import {
  measurementNotFoundError,
  type BpMeasurement,
  type BpMeasurementRepository,
  type MeasurementQuery,
} from '../application/ports/bp-measurement-repository.js';

/** Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); тексты — TASK-101. */
export const STORAGE_CONSTRAINT_MESSAGE_KEY = 'errors.STORAGE_CONSTRAINT';
export const STORAGE_FAILED_MESSAGE_KEY = 'errors.STORAGE_FAILED';

/** data_version стартует с 1 (§13, TASK-021); v1 миграция сеет '1' (TASK-025 §8). */
const INITIAL_DATA_VERSION = 1;

/**
 * SQL мутаций и чтений (§5). Схема — v1 TASK-025 (§8: «использует v1 без
 * изменений»); именованные параметры — параметризованные запросы без конкатенации (§14).
 */
const INSERT_SQL = `
  INSERT INTO bp_measurement (
    id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse,
    irregular_pulse, arm, note, source, created_at_utc, updated_at_utc
  ) VALUES (
    @id, @profile_id, @taken_at_utc, @tz_offset_minutes, @sys, @dia, @pulse,
    @irregular_pulse, @arm, @note, @source, @created_at_utc, @updated_at_utc
  )
`;

/** Полная замена агрегата (§13 TASK-021: edit готовит целую запись); скоуп профиля в WHERE (§14). */
const UPDATE_SQL = `
  UPDATE bp_measurement SET
    taken_at_utc = @taken_at_utc,
    tz_offset_minutes = @tz_offset_minutes,
    sys = @sys,
    dia = @dia,
    pulse = @pulse,
    irregular_pulse = @irregular_pulse,
    arm = @arm,
    note = @note,
    source = @source,
    created_at_utc = @created_at_utc,
    updated_at_utc = @updated_at_utc
  WHERE id = @id AND profile_id = @profile_id
`;

const DELETE_SQL = 'DELETE FROM bp_measurement WHERE id = @id';

/** getById — read без транзакции (§5); ключи строки — имена колонок v1 (RawBpRow). */
const GET_BY_ID_SQL = `
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
  WHERE id = ?
`;

/** data_version читается из meta (§13); сеется миграцией v1 (TASK-025 §8). */
const READ_VERSION_SQL = "SELECT value FROM meta WHERE key = 'data_version'";

/**
 * Bump data_version (§13): value — колонка TEXT (meta v1), инкремент с явным CAST
 * туда и обратно; выполняется ВТОРЫМ statement каждой мутации — в транзакции с записью.
 */
const BUMP_VERSION_SQL =
  "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_version'";

/** Сообщение fail-point'а (§13): попадает в cause STORAGE/FAILED, наружу — только код. */
const FAIL_POINT_MESSAGE =
  'SqliteBpMeasurementRepository: искусственный сбой после первого statement транзакции (fail-point — инъекция теста, TASK-026 §13)';

/**
 * Типобезопасное зеркало bp_measurement v1 (TASK-025 §8; DDL здесь НЕ генерируется).
 * Служит только СБОРКЕ SQL listByPeriod (QueryBuilder → toSQL): исполнение — свои
 * statements, поэтому enum-типы arm/source нужны для типобезопасности условий
 * (eq принимает только 'left' | 'right'), конвертация 0/1 ↔ boolean — в маппере (§7).
 */
const bpMeasurementTable = sqliteTable('bp_measurement', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  takenAtUtc: integer('taken_at_utc').notNull(),
  tzOffsetMinutes: integer('tz_offset_minutes').notNull(),
  sys: integer('sys').notNull(),
  dia: integer('dia').notNull(),
  pulse: integer('pulse'),
  irregularPulse: integer('irregular_pulse').notNull(),
  arm: text('arm', { enum: ['left', 'right'] }).notNull(),
  note: text('note'),
  source: text('source', { enum: ['manual', 'import'] }).notNull(),
  createdAtUtc: integer('created_at_utc').notNull(),
  updatedAtUtc: integer('updated_at_utc').notNull(),
});

/**
 * Строка bp_measurement, как её отдают better-sqlite3 и SELECT из зеркала: ключи —
 * имена колонок v1 (снек_кейс), флаг — число 0/1, опционалы — NULL. Единая форма
 * row-mapper'а для getById (сырой statement) и listByPeriod (сборка Drizzle, §5/§7).
 */
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

/**
 * Восстанавливает VO давления структурно (см. шапку: адаптер не импортирует domain —
 * матрица арх. 03 §4). equals — контракт VO BloodPressure (равенство по полям,
 * TASK-016): доставляется с семантикой VO и non-enumerable — собственные ключи
 * объекта только данные, toEqual контрактного набора не видит метод (TASK-021 §19.1).
 */
function bloodPressureOf(sys: number, dia: number): BpMeasurement['bp'] {
  const bp = { sys, dia };
  Object.defineProperty(bp, 'equals', {
    value: (other: BpMeasurement['bp']): boolean => other.sys === sys && other.dia === dia,
    enumerable: false,
  });
  return bp as BpMeasurement['bp'];
}

/**
 * Row-mapper строка → агрегат (§7): pulse NULL → undefined, note NULL → undefined,
 * 0/1 → boolean, пара колонок → Instant. Приведения типов (пульс-бренд, arm/source)
 * опираются на то, что значения записаны доменом и страхуются CHECK'ами v1 (TASK-025).
 */
function rowToAggregate(row: RawBpRow): BpMeasurement {
  const takenAt: Instant = { utcMs: row.taken_at_utc, tzOffsetMin: row.tz_offset_minutes };
  return {
    id: row.id,
    profileId: row.profile_id,
    bp: bloodPressureOf(row.sys, row.dia),
    pulse: row.pulse === null ? undefined : (row.pulse as BpMeasurement['pulse']),
    irregularPulse: row.irregular_pulse !== 0,
    arm: row.arm as BpMeasurement['arm'],
    note: row.note ?? undefined,
    takenAt,
    source: row.source as BpMeasurement['source'],
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

/** Row-mapper агрегат → строка (§7): undefined → NULL, boolean → 0/1, Instant → 2 колонки. */
function aggregateToRow(m: BpMeasurement): RawBpRow {
  return {
    id: m.id,
    profile_id: m.profileId,
    taken_at_utc: m.takenAt.utcMs,
    tz_offset_minutes: m.takenAt.tzOffsetMin,
    sys: m.bp.sys,
    dia: m.bp.dia,
    pulse: m.pulse ?? null,
    irregular_pulse: m.irregularPulse ? 1 : 0,
    arm: m.arm,
    note: m.note ?? null,
    source: m.source,
    created_at_utc: m.createdAtUtc,
    updated_at_utc: m.updatedAtUtc,
  };
}

/**
 * Маппинг ошибки БД в AppError (§9): SQLITE_CONSTRAINT_* → STORAGE/CONSTRAINT,
 * остальное → STORAGE/FAILED; исходная ошибка — в cause (память main, §14).
 */
function mapDbError(error: unknown): AppError {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return AppError.of('STORAGE/CONSTRAINT', STORAGE_CONSTRAINT_MESSAGE_KEY, undefined, error);
  }
  return AppError.of('STORAGE/FAILED', STORAGE_FAILED_MESSAGE_KEY, undefined, error);
}

/** Логгер адаптера (§18): структурное подмножество HlLogger (матрица арх. 03 §4 — adapters не импортируют shared). */
export interface MeasurementRepoLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** no-op логгер: тесты и вызовы без телеметрии (боевой — createLogger('db'), TASK-027). */
const noopLogger: MeasurementRepoLogger = {
  debug() {},
  error() {},
};

/** Опции конструктора адаптера. */
export interface SqliteBpMeasurementRepositoryOptions {
  /** Логгер мутаций (§18) — боевой: createLogger('db') в контейнере (TASK-027). */
  readonly logger?: MeasurementRepoLogger;
  /**
   * Fail-point (§13, только тесты): после первого statement транзакции бросить
   * синтетическую ошибку — имитация краша между записью строки и bump'ом версии.
   * Принятый и задокументированный механизм интеграционного теста rollback (§19.8).
   */
  readonly failAfterFirstStatementForTesting?: boolean;
}

/**
 * SQLite-реализация порта BpMeasurementRepository (§5). better-sqlite3 синхронный —
 * методы оборачивают результат в Promise.resolve (контракт асинхронный, §9); read —
 * без транзакций (§5), мутации — транзакция «запись + bump data_version» (§13).
 */
export class SqliteBpMeasurementRepository implements BpMeasurementRepository {
  private readonly db: Database.Database;

  /** Prepared statements кэшируются в конструкторе (требование better-sqlite3, §15). */
  private readonly insertStmt: Database.Statement<[RawBpRow]>;

  private readonly updateStmt: Database.Statement<[RawBpRow]>;

  private readonly deleteStmt: Database.Statement<[{ id: string }]>;

  private readonly getByIdStmt: Database.Statement<[string], RawBpRow>;

  private readonly readVersionStmt: Database.Statement<[], { value: string }>;

  private readonly bumpVersionStmt: Database.Statement<[]>;

  /** Обёртка db.transaction (§13): BEGIN…COMMIT; throw внутри → ROLLBACK. */
  private readonly inTransaction: (body: () => Result<void, AppError>) => Result<void, AppError>;

  private readonly logger: MeasurementRepoLogger;

  private readonly failAfterFirstStatementForTesting: boolean;

  constructor(db: Database.Database, options: SqliteBpMeasurementRepositoryOptions = {}) {
    this.db = db;
    this.insertStmt = db.prepare<RawBpRow>(INSERT_SQL);
    this.updateStmt = db.prepare<RawBpRow>(UPDATE_SQL);
    this.deleteStmt = db.prepare<{ id: string }>(DELETE_SQL);
    this.getByIdStmt = db.prepare<[string], RawBpRow>(GET_BY_ID_SQL);
    this.readVersionStmt = db.prepare<[], { value: string }>(READ_VERSION_SQL);
    this.bumpVersionStmt = db.prepare<[]>(BUMP_VERSION_SQL);
    this.inTransaction = db.transaction((body: () => Result<void, AppError>) => body());
    this.logger = options.logger ?? noopLogger;
    this.failAfterFirstStatementForTesting = options.failAfterFirstStatementForTesting === true;
  }

  add(m: BpMeasurement): Promise<Result<void, AppError>> {
    return Promise.resolve(
      this.mutate('add', () => {
        this.insertStmt.run(aggregateToRow(m));
        return ok(undefined);
      }),
    );
  }

  update(m: BpMeasurement): Promise<Result<void, AppError>> {
    return Promise.resolve(
      this.mutate('update', () => {
        // Полная замена агрегата (§13 TASK-021); changes=0 → записи с таким
        // id+profileId нет → NOT_FOUND без бампа (§13/§14: скоуп профиля в WHERE).
        const changes = Number(this.updateStmt.run(aggregateToRow(m)).changes);
        return changes === 0 ? err(measurementNotFoundError()) : ok(undefined);
      }),
    );
  }

  delete(id: string): Promise<Result<void, AppError>> {
    return Promise.resolve(
      this.mutate('delete', () => {
        const changes = Number(this.deleteStmt.run({ id }).changes);
        return changes === 0 ? err(measurementNotFoundError()) : ok(undefined);
      }),
    );
  }

  getById(id: string): Promise<BpMeasurement | undefined> {
    const row = this.getByIdStmt.get(id);
    return Promise.resolve(row === undefined ? undefined : rowToAggregate(row));
  }

  listByPeriod(q: MeasurementQuery): Promise<BpMeasurement[]> {
    // Assert программиста — синхронный throw в точке вызова (§14, прецедент fake TASK-021 §20).
    assertProfileId(q);
    return Promise.resolve(this.listSync(q));
  }

  /**
   * TASK-030 §7/§8: total — COUNT по фильтрам запроса; индекс v1 (TASK-025 §8:
   * profile_id, taken_at_utc) покрывает — дёшево (§15). limit/offset игнорируются
   * (контракт порта: пагинация выборки, не фильтр).
   */
  countByPeriod(q: MeasurementQuery): Promise<number> {
    // Assert программиста — паритет с listByPeriod/fake (§14).
    assertProfileId(q);
    return Promise.resolve(this.countSync(q));
  }

  currentDataVersion(): Promise<number> {
    const row = this.readVersionStmt.get();
    // Строки нет только до миграции v1 (сеет '1', TASK-025) — трактуется как старт (§13).
    return Promise.resolve(row === undefined ? INITIAL_DATA_VERSION : Number(row.value));
  }

  /**
   * Общая механика мутаций (§5/§13): тело — одна транзакция; первый statement —
   * запись строки, второй — bump data_version; сбой между ними → полный rollback
   * (fail-point §13 / ROLLBACK better-sqlite3). Наружу — Result, не throw (§9).
   */
  private mutate(
    method: 'add' | 'update' | 'delete',
    write: () => Result<void, AppError>,
  ): Result<void, AppError> {
    const startedAtMs = performance.now();
    try {
      const result = this.inTransaction(() => {
        const writeResult = write();
        // Fail-point строго ПОСЛЕ первого statement и ДО бампа (§13: «сбой после INSERT»).
        if (this.failAfterFirstStatementForTesting) {
          throw new Error(FAIL_POINT_MESSAGE);
        }
        if (!writeResult.ok) {
          // NOT_FOUND: строки не изменилось — неуспешная мутация, версию не двигаем (§13).
          return writeResult;
        }
        this.bumpVersionStmt.run();
        return ok(undefined);
      });
      // §18: debug — метод и длительность, без значений (PHI-правило).
      this.logger.debug(`measurement.${method}`, {
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return result;
    } catch (error) {
      const appError = mapDbError(error);
      this.logger.error(`measurement.${method} failed`, { code: appError.code });
      return err(appError);
    }
  }

  /**
   * listByPeriod (§5): WHERE-сборка через Drizzle (QueryBuilder → toSQL → параметры) —
   * все фильтры порта пересекаются (И); границы [from, to] включительно (§13);
   * hasNote=true → note IS NOT NULL (домен не пишет пустых заметок — trim, TASK-017 §13,
   * поэтому NULL ≡ «нет заметки»). Сортировка всегда taken_at_utc DESC, tie-break id DESC
   * (§13) — совпадает с newestFirst fake. SQL динамичен (фильтры) — prepared на каждый
   * вызов; фиксированные statements CRUD кэшируются в конструкторе (§15).
   */
  private listSync(q: MeasurementQuery): BpMeasurement[] {
    let query = new QueryBuilder()
      .select()
      .from(bpMeasurementTable)
      .where(and(...this.conditionsFor(q)))
      .orderBy(desc(bpMeasurementTable.takenAtUtc), desc(bpMeasurementTable.id))
      .$dynamic();

    // Пагинация после сортировки (§5/§13): limit отрезает самые новые. SQLite не
    // принимает OFFSET без LIMIT, а Drizzle молча опускает отрицательный LIMIT
    // (диалект: emit только при limit >= 0) — «offset без limit» эмитится
    // sentinel-лимитом (максимум safe-integer: практического ограничения нет).
    const hasOffset = q.offset !== undefined && q.offset !== 0;
    if (q.limit !== undefined) {
      query = query.limit(q.limit);
    } else if (hasOffset) {
      query = query.limit(Number.MAX_SAFE_INTEGER);
    }
    if (hasOffset) {
      query = query.offset(q.offset);
    }

    const { sql, params } = query.toSQL();
    return (this.db.prepare(sql).all(...params) as RawBpRow[]).map(rowToAggregate);
  }

  /**
   * TASK-030 §8: COUNT-запрос по тем же фильтрам (общая WHERE-сборка с listSync —
   * «total по тем же фильтрам», §7); ORDER BY не нужен, limit/offset не эмитятся.
   * Совпадение фильтров с listByPeriod страхуется контрактным набором (группа 8).
   */
  private countSync(q: MeasurementQuery): number {
    // Алиас обязателен: QueryBuilder.select({…}) эмитит поле БЕЗ алиаса только для
    // агрегатов-фабрик (count()), а строку better-sqlite3 нужно читать по имени.
    const query = new QueryBuilder()
      .select({ total: sql<number>`count(*)`.as('total') })
      .from(bpMeasurementTable)
      .where(and(...this.conditionsFor(q)));
    const { sql: sqlText, params } = query.toSQL();
    // COUNT без GROUP BY всегда отдаёт одну строку.
    const row = this.db.prepare(sqlText).get(...params) as { total: number };
    return Number(row.total);
  }

  /** WHERE-условия порта (И): скоуп профиля (§14) + from/to/arm/hasNote по наличию (§13). */
  private conditionsFor(q: MeasurementQuery): SQL[] {
    const conditions: SQL[] = [eq(bpMeasurementTable.profileId, q.profileId)];
    if (q.fromUtcMs !== undefined) {
      conditions.push(gte(bpMeasurementTable.takenAtUtc, q.fromUtcMs));
    }
    if (q.toUtcMs !== undefined) {
      conditions.push(lte(bpMeasurementTable.takenAtUtc, q.toUtcMs));
    }
    if (q.arm !== undefined) {
      conditions.push(eq(bpMeasurementTable.arm, q.arm));
    }
    if (q.hasNote === true) {
      conditions.push(isNotNull(bpMeasurementTable.note));
    }
    return conditions;
  }
}

/**
 * §14: запрос без непустого profileId — программная ошибка (принудительный скоуп,
 * арх. 08 §3): assert — синхронный throw TypeError в точке вызова, не AppError
 * (документированный dev-контракт, §20 TASK-021 — паритет с fake).
 */
function assertProfileId(q: MeasurementQuery): void {
  if (typeof q.profileId !== 'string' || q.profileId.length === 0) {
    throw new TypeError(
      'MeasurementQuery.profileId обязателен и не может быть пустым — запрос без скоупа профиля является программной ошибкой (TASK-021 §14, арх. 08 §3)',
    );
  }
}
