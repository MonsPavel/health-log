/**
 * TASK-021 §9: in-memory реализация порта BpMeasurementRepository — Map<string,
 * BpMeasurement> по id + локальный счётчик data_version. Обслуживает use case'ы
 * (TASK-029) до SQLite-адаптера (TASK-026) и прогоняет с ним один контрактный набор
 * (repository.contract.test.ts) — доверие «fake ≈ адаптер» (§3). Потокобезопасность
 * не требуется: однопоточный Node, вызовы из use case'ов последовательны (§9).
 *
 * dev-контракты (TypeError — ошибка программиста, прецедент §20):
 *  - listByPeriod без непустого profileId — принудительный скоуп профиля (§14, арх. 08 §3);
 *  - add с существующим id: в боевом потоке невозможно (uuid v7, TASK-017); молчаливая
 *    перезапись замаскировала бы ошибку и разошлась с SQLite-адаптером (STORAGE/CONSTRAINT,
 *    TASK-026 §9) — assert, расхождение должно быть громким (§22).
 */
import { err, ok, type AppError, type Result } from '@hl/kernel';

import {
  measurementNotFoundError,
  type BpMeasurement,
  type BpMeasurementRepository,
  type MeasurementQuery,
} from '../application/ports/bp-measurement-repository.js';

/** data_version стартует с 1 (§13). */
const INITIAL_DATA_VERSION = 1;

/**
 * Сортировка listByPeriod: takenAt desc, tie-break id desc (§13). Направление tie-break
 * совпадает с SQL SQLite-адаптера (TASK-026 §5: ORDER BY taken_at_utc DESC, id DESC) —
 * иначе общий контрактный набор не может быть общим.
 */
function newestFirst(a: BpMeasurement, b: BpMeasurement): number {
  if (a.takenAt.utcMs !== b.takenAt.utcMs) {
    return b.takenAt.utcMs - a.takenAt.utcMs;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * §14: запрос без непустого profileId — программная ошибка (принудительный скоуп,
 * арх. 08 §3): assert (TypeError), не AppError — допустимо в dev-контракте (§20).
 */
function assertProfileId(q: MeasurementQuery): void {
  if (typeof q.profileId !== 'string' || q.profileId.length === 0) {
    throw new TypeError(
      'MeasurementQuery.profileId обязателен и не может быть пустым — запрос без скоупа профиля является программной ошибкой (TASK-021 §14, арх. 08 §3)',
    );
  }
}

/** In-memory fake порта: полная семантика §7/§13 на Map по id. */
export class InMemoryBpMeasurementRepository implements BpMeasurementRepository {
  private readonly records = new Map<string, BpMeasurement>();
  private dataVersion = INITIAL_DATA_VERSION;

  async add(m: BpMeasurement): Promise<Result<void, AppError>> {
    if (this.records.has(m.id)) {
      throw new TypeError(
        `InMemoryBpMeasurementRepository.add: запись с id ${m.id} уже существует — id генерирует uuid v7 (TASK-017), дубликат является программной ошибкой`,
      );
    }
    this.records.set(m.id, m);
    this.dataVersion += 1;
    return ok(undefined);
  }

  async update(m: BpMeasurement): Promise<Result<void, AppError>> {
    if (!this.records.has(m.id)) {
      return err(measurementNotFoundError());
    }
    this.records.set(m.id, m);
    this.dataVersion += 1;
    return ok(undefined);
  }

  async delete(id: string): Promise<Result<void, AppError>> {
    if (!this.records.has(id)) {
      return err(measurementNotFoundError());
    }
    this.records.delete(id);
    this.dataVersion += 1;
    return ok(undefined);
  }

  async getById(id: string): Promise<BpMeasurement | undefined> {
    return this.records.get(id);
  }

  async listByPeriod(q: MeasurementQuery): Promise<BpMeasurement[]> {
    assertProfileId(q);
    const { profileId, arm, hasNote } = q;
    const from = q.fromUtcMs;
    const to = q.toUtcMs;
    // Все условия пересекаются (И); границы периода включительные [from, to] (§13);
    // hasNote=true → только с непустой заметкой — иное значение фильтр не активирует (§13).
    const selected = [...this.records.values()].filter(
      (m) =>
        m.profileId === profileId &&
        (from === undefined || m.takenAt.utcMs >= from) &&
        (to === undefined || m.takenAt.utcMs <= to) &&
        (arm === undefined || m.arm === arm) &&
        (hasNote !== true || m.note !== undefined),
    );
    selected.sort(newestFirst);
    // Пагинация простыми limit/offset (§5); окно после сортировки — limit отрезает самые новые.
    const offset = q.offset ?? 0;
    return q.limit === undefined
      ? selected.slice(offset)
      : selected.slice(offset, offset + q.limit);
  }

  async currentDataVersion(): Promise<number> {
    return this.dataVersion;
  }
}
