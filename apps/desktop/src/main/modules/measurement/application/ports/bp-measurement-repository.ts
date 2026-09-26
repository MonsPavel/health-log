/**
 * TASK-021 §4/§7: порт репозитория измерений — application-слой (арх. 02 §5, 03 §2:
 * репозиторий — инфраструктурная потребность use case'ов, домен о хранении не знает).
 * Реализации — адаптеры модуля: in-memory fake (TASK-021) и SQLite (TASK-026);
 * взаимозаменяемость обеспечивает общий контрактный набор repository.contract.test.ts.
 *
 * Сигнатуры §7 с одной уточняющей трактовкой (документировано в summary TASK-021):
 * эскиз §7 показывает `Promise<void>` у мутаций, но семантика §7 («delete несуществующего
 * → Result err MEASUREMENT/NOT_FOUND, не throw») и критерий §20 требуют доставки ошибки
 * значением — мутации единообразно возвращают Promise<Result<void, AppError>> (add — под
 * будущие STORAGE/* коды TASK-026 §9; исключения не пересекают слои, арх. 02 §5).
 * Чтение — значения без Result (эскиз §7; неуспех чтения контрактом не определён).
 *
 * data_version — часть контракта порта (§5 «не включено»): currentDataVersion() и
 * автоинкремент при каждой успешной мутации (§13) — так «запись + версия атомарны»
 * есть факт порта, а не соглашение реализаций. Все методы асинхронные (§7): контракт
 * единый для fake и синхронного внутри better-sqlite3 (Promise.resolve-обёртка).
 *
 * profileId обязателен в каждом запросе (§14, арх. 08 §3 — принудительный скоуп):
 * запрос без непустого profileId — программная ошибка; реализация упасть assert'ом —
 * синхронный throw TypeError в точке вызова — задокументированный dev-контракт (§20),
 * не AppError.
 */
import { AppError, type Result } from '@hl/kernel';

import type { Arm } from '../../domain/arm.js';
import { MEASUREMENT_NOT_FOUND_MESSAGE_KEY } from '../../domain/constants.js';
import type { BpMeasurement } from '../../domain/bp-measurement.js';

/**
 * Доменные типы в контракте порта. Реэкспорт отсюда обязателен: матрица арх. 03 §4
 * разрешает adapters импортировать только application-порты своего модуля (не domain) —
 * реализациям порта агрегат доступен через порт.
 */
export type { Arm, BpMeasurement };

/** Запрос выборки listByPeriod (§7): условия пересекаются (И); from/to включительно (§13). */
export interface MeasurementQuery {
  /** Профиль-владелец: обязателен — принудительный скоуп (§14, арх. 08 §3). */
  readonly profileId: string;
  /** Нижняя граница периода по takenAt.utcMs, включительно (§13). */
  readonly fromUtcMs?: number;
  /** Верхняя граница периода по takenAt.utcMs, включительно (§13). */
  readonly toUtcMs?: number;
  /** Фильтр по руке измерения. */
  readonly arm?: Arm;
  /** true → только записи с непустой заметкой (§13); остальные значения фильтр не активируют. */
  readonly hasNote?: boolean;
  /** Максимум записей (после сортировки desc); undefined — без ограничения. */
  readonly limit?: number;
  /** Сколько самых новых пропустить; undefined — 0. */
  readonly offset?: number;
}

/** Порт хранилища агрегатов BpMeasurement (§7). */
export interface BpMeasurementRepository {
  /** Добавляет агрегат; data_version+1 атомарно с записью (§7/§13). */
  add(m: BpMeasurement): Promise<Result<void, AppError>>;
  /**
   * Полная замена агрегата по m.id — edit из TASK-017 готовит целую запись (§13);
   * несуществующий id → err MEASUREMENT/NOT_FOUND; data_version+1.
   */
  update(m: BpMeasurement): Promise<Result<void, AppError>>;
  /** Удаляет запись; несуществующий id → err MEASUREMENT/NOT_FOUND, не throw (§7); data_version+1. */
  delete(id: string): Promise<Result<void, AppError>>;
  /** Чтение по id; запись отсутствует → undefined. */
  getById(id: string): Promise<BpMeasurement | undefined>;
  /** Выборка по запросу; сортировка всегда takenAt desc, tie-break id desc (§13). */
  listByPeriod(q: MeasurementQuery): Promise<BpMeasurement[]>;
  /**
   * Число записей, подходящих под фильтры запроса (TASK-030 §7: total = COUNT по тем
   * же фильтрам, что listByPeriod). limit/offset запроса ИГНОРИРУЮТСЯ — это пагинация
   * выборки, а не фильтр: total считается по всем подходящим записям (счётчик «N
   * измерений» и пагинация UI, §3). Сортировка для счёта не нужна.
   */
  countByPeriod(q: MeasurementQuery): Promise<number>;
  /** Текущая data_version: старт 1, +1 за успешную мутацию, никогда не откатывается (§13). */
  currentDataVersion(): Promise<number>;
}

/**
 * Единая для всех реализаций ошибка «запись не найдена» (§7/§13): фабрика живёт в порту,
 * чтобы fake и SQLite-адаптер возвращали идентичный AppError — доверие «fake ≈ адаптер»
 * обеспечивается одинаковым кодом и ключом сообщения (§3).
 */
export function measurementNotFoundError(): AppError {
  return AppError.of('MEASUREMENT/NOT_FOUND', MEASUREMENT_NOT_FOUND_MESSAGE_KEY);
}
