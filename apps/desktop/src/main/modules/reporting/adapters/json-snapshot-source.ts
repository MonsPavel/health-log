/**
 * TASK-065 §5/§8: боевой адаптер порта ExportJsonSource (application reporting) —
 * перенос инлайн-источника roundtrip-теста TASK-064 (reporting-export-json.int.test.ts,
 * шапка: «вынесение адаптеров в reporting/adapters — TASK-065»). Нового SQL — минимум:
 * только чтение профиля (таблица v1, факты хранилища); журнал — через порт
 * BpMeasurementRepository.listByPeriod (TASK-021), маппинг в MeasurementDto (TASK-028)
 * — общий toMeasurementDto канала add (переиспользование, §7).
 *
 * Порядок отдачи — контракт listByPeriod (takenAt desc, tie-break id desc);
 * разворот в asc делает use case 064 (§13). Отсутствие профиля → undefined —
 * пустой слепок не ошибка (§9). Скоуп профиля (§14): запрос строго {profileId}.
 */
import type { JsonSnapshotProfile, MeasurementDto } from '@hl/contracts';

import type { EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type { BpMeasurementRepository } from '../../measurement/index.js';
import { toMeasurementDto } from '../../measurement/index.js';
import type { ExportJsonSource } from '../application/export-json.js';

/** Строка таблицы profile (миграция v1): факты хранилища профиля. */
interface ProfileRow {
  readonly id: string;
  readonly name: string;
  readonly created_at_utc: number;
}

/** Минимальная поверхность БД адаптера (structural, §19-прецедент портов). */
type ProfileReader = Pick<EncryptedDatabase, 'prepare'>;

/** Зависимости адаптера (§7): открытое соединение + порт журнала. */
export interface JsonSnapshotSourceDeps {
  /** Открытая зашифрованная БД (чтение таблицы profile; контейнер передаёт соединение). */
  readonly db: ProfileReader;
  /** Порт журнала измерений (TASK-021) — чтение для слепка. */
  readonly repo: Pick<BpMeasurementRepository, 'listByPeriod'>;
}

/** Адаптер источника слепка (§5/§8): профиль + замеры профиля. */
export class JsonSnapshotSource implements ExportJsonSource {
  private readonly profileStmt: { get(profileId: string): ProfileRow | undefined };
  private readonly repo: Pick<BpMeasurementRepository, 'listByPeriod'>;

  constructor(deps: JsonSnapshotSourceDeps) {
    this.profileStmt = deps.db.prepare<[string], ProfileRow>(
      'SELECT id, name, created_at_utc FROM profile WHERE id = ?',
    );
    this.repo = deps.repo;
  }

  /** Профиль по id (§5): отсутствует → undefined (пустой слепок — не ошибка, §9). */
  getProfile(profileId: string): Promise<JsonSnapshotProfile | undefined> {
    const row = this.profileStmt.get(profileId);
    return Promise.resolve(
      row === undefined
        ? undefined
        : { id: row.id, name: row.name, createdAtUtc: row.created_at_utc },
    );
  }

  /** Все измерения профиля (§5) в форме DTO TASK-028. */
  listMeasurements(profileId: string): Promise<MeasurementDto[]> {
    return this.repo
      .listByPeriod({ profileId })
      .then((measurements) => measurements.map(toMeasurementDto));
  }
}
