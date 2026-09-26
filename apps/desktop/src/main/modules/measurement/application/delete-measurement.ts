/**
 * TASK-032 §2/§5: use case DeleteMeasurement — удаление только что созданной записи
 * в модальном потоке «Проверьте значения» (UC-01 A1/A2, SRS 06): сохранение уже
 * произошло атомарно и просто (TASK-029 §13 — двухфазность отклонена), пользователь
 * решает судьбу записи post-factum: «Исправить» = удалить созданное + возврат к форме
 * с сохранённым вводом. Никаких блокировок ввода (EC-03).
 *
 * ПОРЯДОК (§9: «Delete: repo.delete → события → лог. Порядок с событиями: как в add»):
 *  1. чтение записи по id — ради profileId события `measurement:changed` (payload
 *     события — контракт events: профиль обязателен, а в запросе delete только {id});
 *  2. записи нет → err MEASUREMENT/NOT_FOUND (§7: «запись уже удалена другим путём —
 *     UI показывает „уже удалена“, не ошибка-краш»); порт вернул бы ту же ошибку —
 *     короткий путь с тем же исходом, БД не трогается;
 *  3. repo.delete — упало (STORAGE/*) → err + лог, событий нет;
 *  4. события — только после успешного delete, всегда оба, по порядку add (§9):
 *     `measurement:changed {profileId}`, `data:versionBumped {newVersion}` (newVersion —
 *     контракт порта TASK-021: data_version+1 атомарно с мутацией);
 *  5. лог — длительность, без значений измерений (PHI, TASK-010).
 *
 * ПОВТОРНОЕ ИСПОЛЬЗОВАНИЕ (§4/§23): канал `measurements/delete` — реализация схемы
 * TASK-028; TASK-037 позже добавит к этому use case'у full-edit (update).
 *
 * ЗАВИСИМОСТИ (§7): {repo, events, logger} — подстановочные в тестах (fake-repo
 * TASK-021, vi.fn); поверхности портов — те же структурные, что у add (§7 TASK-029).
 * profileId здесь НЕ нужен в команде: он берётся из самой записи — принудительный
 * скоуп профиля (§14, арх. 08 §3) на границе канала не проходит, запись уже
 * принадлежит своему профилю.
 */
import { performance } from 'node:perf_hooks';

import type { HlEventMap } from '@hl/contracts';
import { err, isErr, ok, type AppError, type Result } from '@hl/kernel';

import {
  measurementNotFoundError,
  type BpMeasurementRepository,
} from './ports/bp-measurement-repository.js';

/** Минимальная поверхность шины событий для use case (§7, прецедент AddMeasurementEvents). */
export interface DeleteMeasurementEvents {
  emit<K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]): void;
}

/** Минимальная поверхность логгера use case (§18-стиль add); HlLogger ей удовлетворяет. */
export interface DeleteMeasurementLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах. */
export interface DeleteMeasurementDeps {
  readonly repo: BpMeasurementRepository;
  readonly events: DeleteMeasurementEvents;
  readonly logger: DeleteMeasurementLogger;
}

/** Команда (§11: запрос канала TASK-028 — {id}). */
export interface DeleteMeasurementCommand {
  readonly id: string;
}

/** Результат успешного выполнения (§7). */
export interface DeleteResult {
  readonly deleted: true;
}

/** Use case удаления (§5): execute({id}) → Result<DeleteResult>. */
export class DeleteMeasurementUseCase {
  constructor(private readonly deps: DeleteMeasurementDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, исключения не пересекают слои. */
  async execute(cmd: DeleteMeasurementCommand): Promise<Result<DeleteResult, AppError>> {
    const startedAtMs = performance.now();

    // 1. Чтение ради profileId события (§9 — payload measurement:changed несёт профиль).
    const existing = await this.deps.repo.getById(cmd.id);
    if (existing === undefined) {
      // 2. NOT_FOUND (§7/§13): запись уже удалена другим путём — ожидаемый кейс, не
      //    отказ хранения: debug-лог, событий нет, БД не трогается.
      this.deps.logger.debug('deleteMeasurement: запись отсутствует (уже удалена)');
      return err(measurementNotFoundError());
    }

    // 3. Удаление (§9): упало (STORAGE/*) → err + лог, событий нет.
    const deleted = await this.deps.repo.delete(cmd.id);
    if (isErr(deleted)) {
      this.deps.logger.error('deleteMeasurement: удаление не удалось', {
        code: deleted.error.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: deleted.error };
    }

    // 4. События — только после успешного delete, оба, порядок «как в add» (§9).
    const newVersion = await this.deps.repo.currentDataVersion();
    this.deps.events.emit('measurement:changed', { profileId: existing.profileId });
    this.deps.events.emit('data:versionBumped', { newVersion });

    // 5. Лог: длительность — без значений измерений (PHI, TASK-010).
    this.deps.logger.info('deleteMeasurement', {
      durationMs: Math.round(performance.now() - startedAtMs),
    });

    return ok({ deleted: true });
  }
}
