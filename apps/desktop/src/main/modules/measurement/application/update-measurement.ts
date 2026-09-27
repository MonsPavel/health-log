/**
 * TASK-037 §2/§5: use case UpdateMeasurement — полная правка любой записи журнала
 * (US-2: «ошибку можно исправить», NFR-12-дух) через `edit`-фабрику агрегата
 * (TASK-017: семантика порта — полная замена строки). Порядок §9: getById
 * (NOT_FOUND) → edit (домен) → флаги → update → события → Result ok.
 *
 * ПОРЯДОК И ОТКАЗЫ (§9):
 *  1. getById — записи нет → err MEASUREMENT/NOT_FOUND (§13 delete-прецедент: запись
 *     уже удалена другим путём — ожидаемый кейс, debug-лог), БД и события не трогаются;
 *  2. `BpMeasurement.edit(existing, cmd, clock)` (домен, с Clock) — ошибка → Result err
 *     (FUTURE_TIME и т.д.), БД и события не трогаются; правка не может «испортить»
 *     запись: инварианты пере проверяются полностью, id/profileId/source/createdAtUtc
 *     наследуются от существующей записи (перенос между профилями правкой не выражается);
 *  3. флаги (§13): TypoHeuristic пересчитывается против истории 14 дней от НОВОГО
 *     takenAt кандидата с ИСКЛЮЧЕНИЕМ правимой записи (фильтр id≠ — иначе запись сама
 *     себе «норма»); значения для сравнения — НОВЫЕ из команды. CriticalValuePolicy —
 *     по новым sys/dia. Duplicate НЕ пересчитывается (решение §5: правка не создаёт
 *     дубль-риск) и в ответе отсутствует (контрактный тест формы ответа);
 *  4. repo.update — упало (STORAGE/*) → err + лог, событий нет;
 *  5. события — только после успешного update, всегда оба, в порядке add/delete
 *     (§22: единый стиль CRUD): `measurement:changed {profileId}`,
 *     `data:versionBumped {newVersion}` (newVersion — контракт порта TASK-021:
 *     data_version+1 атомарно с мутацией);
 *  6. лог §18: `updateMeasurement durationMs flags=[typo? critical-…]` — БЕЗ значений
 *     измерений (PHI, TASK-010).
 *
 * КОНКУРЕНТНОСТЬ (§13): две правки одной записи — последняя побеждает (версионирование
 * строк не нужно — FR-2.4, один пользователь; оптимистичная блокировка §23 — не нужна).
 *
 * FTS-СИНХРОНИЗАЦИЯ ЗАМЕТОК (§5, комментарий-требование): при update заметка может
 * измениться — FTS-индекс заметок появится в TASK-045 с триггерами БД, которые покроют
 * update автоматически (UPDATE-триггер по bp_measurement); здесь синхронизация не
 * выполняется — до TASK-045 заметки в FTS не участвуют.
 *
 * ЗАВИСИМОСТИ (§7): {repo, clock, events, logger} — подстановочные в тестах
 * (fake-repo TASK-021, FixedClock, vi.fn); поверхности портов — те же структурные,
 * что у add/delete (§7 TASK-029/032: прецеденты AddMeasurementEvents/Logger).
 *
 * БЕЗОПАСНОСТЬ (§14): как в add — команда валидирована zod-каркасом канала
 * (TASK-028); profileId правимой записи берётся ИЗ ЗАПИСИ (в схеме update его нет —
 * принудительный скоуп, арх. 08 §3): перенос между профилями правкой не выражается.
 */
import { performance } from 'node:perf_hooks';

import type { HlEventMap, MeasurementDto } from '@hl/contracts';
import { err, isErr, ok, type AppError, type Clock, type Result } from '@hl/kernel';

import { BpMeasurement } from '../domain/bp-measurement.js';
import { assessCritical, type CriticalFlag } from '../domain/critical-value-policy.js';
import { TYPO_WINDOW_DAYS } from '../domain/constants.js';
import type { EditMeasurementCommand } from '../domain/measurement-commands.js';
import { detectTypo, type TypoFlag } from '../domain/typo-heuristic.js';
import { toMeasurementDto } from './add-measurement.js';
import {
  measurementNotFoundError,
  type BpMeasurementRepository,
} from './ports/bp-measurement-repository.js';

/** Миллисекунды в сутках: пересчёт TYPO_WINDOW_DAYS в окно listByPeriod (§5). */
const MS_PER_DAY = 86_400_000;
/** Глубина истории TypoHeuristic (§5: «лимит 100» — TASK-018 §78: массив ≤100). */
const TYPO_HISTORY_LIMIT = 100;

/** Минимальная поверхность шины событий для use case (§7, прецедент AddMeasurementEvents). */
export interface UpdateMeasurementEvents {
  emit<K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]): void;
}

/** Минимальная поверхность логгера use case (§18); HlLogger контейнера ей удовлетворяет. */
export interface UpdateMeasurementLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах. */
export interface UpdateMeasurementDeps {
  readonly repo: BpMeasurementRepository;
  readonly clock: Clock;
  readonly events: UpdateMeasurementEvents;
  readonly logger: UpdateMeasurementLogger;
}

/** Команда (§5/§7): схема `measurements/update` TASK-028 — {id, …поля правки}. */
export interface UpdateMeasurementCommand extends EditMeasurementCommand {
  readonly id: string;
}

/** Флаги эвристик ответа (§7): без duplicate — правка не создаёт дубль-риск (§5). */
export interface UpdateMeasurementFlags {
  readonly typo?: TypoFlag;
  readonly criticalValue: CriticalFlag;
}

/** Результат успешного выполнения (§7): DTO канала + флаги. */
export interface UpdateResult {
  readonly measurement: MeasurementDto;
  readonly flags: UpdateMeasurementFlags;
}

/** Метки флагов для лога §18: `flags=[typo,critical-high]` — без значений (прецедент add). */
function flagLabels(flags: UpdateMeasurementFlags): string[] {
  const labels: string[] = [];
  if (flags.typo !== undefined) {
    labels.push('typo');
  }
  if (flags.criticalValue !== undefined) {
    labels.push(`critical-${flags.criticalValue}`);
  }
  return labels;
}

/** Use case UC-правка (§5): execute({id, …поля}) → Result<UpdateResult>. */
export class UpdateMeasurementUseCase {
  constructor(private readonly deps: UpdateMeasurementDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, исключения не пересекают слои. */
  async execute(cmd: UpdateMeasurementCommand): Promise<Result<UpdateResult, AppError>> {
    const startedAtMs = performance.now();

    // 1. getById (§9): записи нет → NOT_FOUND (ожидаемый кейс, debug-лог), БД не трогается.
    const existing = await this.deps.repo.getById(cmd.id);
    if (existing === undefined) {
      this.deps.logger.debug('updateMeasurement: запись отсутствует (уже удалена)');
      return err(measurementNotFoundError());
    }

    // 2. Домен (§9): `edit` с Clock — полная пересборка агрегата с наследованием
    //    id/profileId/source/createdAtUtc; err наружу, БД не трогается.
    const edited = BpMeasurement.edit(existing, cmd, this.deps.clock);
    if (isErr(edited)) {
      this.deps.logger.debug('updateMeasurement: домен отклонил правку', {
        code: edited.error.code,
      });
      return err(edited.error);
    }
    const measurement = edited.value;

    // 3. Флаги (§13) — до сохранения: история 14 дней от НОВОГО takenAt кандидата
    //    (§13 TASK-018: окно отсчитывает use case), правимая запись исключена (id≠) —
    //    иначе запись сама себе «норма»; сравниваются НОВЫЕ значения команды.
    const takenAtUtcMs = measurement.takenAt.utcMs;
    const typoHistory = await this.deps.repo.listByPeriod({
      profileId: existing.profileId,
      fromUtcMs: takenAtUtcMs - TYPO_WINDOW_DAYS * MS_PER_DAY,
      toUtcMs: takenAtUtcMs,
      limit: TYPO_HISTORY_LIMIT,
    });
    const candidate = { sys: measurement.bp.sys, dia: measurement.bp.dia };
    const flags: UpdateMeasurementFlags = {
      typo: detectTypo(
        typoHistory.filter((m) => m.id !== cmd.id),
        candidate,
      ),
      criticalValue: assessCritical(candidate.sys, candidate.dia),
    };

    // 4. Сохранение (§9): полная замена строки (семантика порта TASK-021); упало
    //    (STORAGE/*) → err + лог, событий нет.
    const updated = await this.deps.repo.update(measurement);
    if (isErr(updated)) {
      this.deps.logger.error('updateMeasurement: сохранение не удалось', {
        code: updated.error.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: updated.error };
    }

    // 5. События — только после успешного update, всегда оба, порядок как в add/delete
    //    (§22): newVersion — контракт порта TASK-021 (data_version+1 атомарно с мутацией).
    const newVersion = await this.deps.repo.currentDataVersion();
    this.deps.events.emit('measurement:changed', { profileId: existing.profileId });
    this.deps.events.emit('data:versionBumped', { newVersion });

    // 6. Лог (§18): длительность и метки флагов — без значений (PHI, TASK-010).
    this.deps.logger.info('updateMeasurement', {
      durationMs: Math.round(performance.now() - startedAtMs),
      flags: flagLabels(flags),
    });

    return ok({ measurement: toMeasurementDto(measurement), flags });
  }
}
