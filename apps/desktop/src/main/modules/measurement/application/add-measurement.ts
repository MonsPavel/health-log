/**
 * TASK-029 §2/§5: use case AddMeasurement — прикладной сценарий UC-01 (SRS 06):
 * валидация домена → выборка недавней истории → эвристики опечатки/дубля →
 * сохранение → ответ с флагами и criticalValue; публикация событий
 * `measurement:changed`, `data:versionBumped` (арх. 05 §5 — первый сквозной поток
 * «UI → домен → шифрованная БД → UI»).
 *
 * ПОРЯДОК И ОТКАЗЫ (§9):
 *  1. `BpMeasurement.create` (домен, с Clock) — ошибка → Result err (FUTURE_TIME и
 *     т.д.), БД и события не трогаются;
 *  2. выборка истории — после валидации, до сохранения: окно TypoHeuristic
 *     (14 дней ДО takenAt кандидата — не от часов, TASK-018 §46; лимит 100) и
 *     recent для DuplicateDetector (лимит 10);
 *  3. флаги — чистые функции домена TASK-018/019/020;
 *  4. repo.add — упало (STORAGE/*) → err + лог, событий нет;
 *  5. события — ТОЛЬКО после успешного add, всегда оба: `measurement:changed
 *     {profileId}`, `data:versionBumped {newVersion}` (newVersion — контракт порта
 *     TASK-021: data_version+1 атомарно с записью, поэтому currentDataVersion()
 *     сразу после add и есть новая версия);
 *  6. лог §18: `addMeasurement durationMs={n} flags=[typo,duplicate,critical-high]` —
 *     БЕЗ значений измерений (PHI, TASK-010).
 *
 * ФЛАГИ ИНФОРМАЦИОННЫЕ, НЕ БЛОКИРУЮЩИЕ (§13): use case ВСЕГДА сохраняет и всегда
 * возвращает флаги; «two-step save» на уровне use case не делается — UI сам решает,
 * показать ли подсказку post-factum с опцией удаления (TASK-032, §22). Дубли между
 * двумя быстрыми вызовами: сохранятся оба, детектор сработает на втором (окно 2 мин).
 *
 * ТРАКТОВКА «recent 10» (§5, документируется): recent запрашивается ОКНОМ ДУБЛЯ
 * вокруг момента кандидата (`takenAt ± DUPLICATE_WINDOW_MS`, лимит 10), а не «10
 * последними по профилю» — детектор сравнивает только записи в пределах 2 минут от
 * кандидата (TASK-019 §7), поэтому записи вне окна вердикт изменить не могут, а
 * backdated-ввод (US-3) получает ту же защиту, что и ввод «сейчас». Сам детектор
 * сохраняет своё окно-правило без изменений (pure, §7 TASK-019).
 *
 * ЗАВИСИМОСТИ (§7): `{repo, clock, events, logger}` — подстановочные в тестах
 * (fake-repo TASK-021, FixedClock, vi.fn). Порты событий/логгера — структурные
 * (минимальная поверхность, прецедент IpcLogger/EventsLogger/VaultLogger):
 * EventBus main и createLogger('app') контейнера им удовлетворяют.
 *
 * БЕЗОПАСНОСТЬ (§14): profileId из команды используется как есть (валиден по схеме
 * канала TASK-028); будущий session-scope (арх. 08 §3) подменит источник в этом
 * месте — точка расширения.
 */
import { performance } from 'node:perf_hooks';

import type { HlEventMap, MeasurementDto } from '@hl/contracts';
import { err, isErr, ok, type AppError, type Clock, type Result } from '@hl/kernel';

import { BpMeasurement } from '../domain/bp-measurement.js';
import { assessCritical, type CriticalFlag } from '../domain/critical-value-policy.js';
import { DUPLICATE_WINDOW_MS, TYPO_WINDOW_DAYS } from '../domain/constants.js';
import { detectDuplicate } from '../domain/duplicate-detector.js';
import type { CreateMeasurementCommand } from '../domain/measurement-commands.js';
import { detectTypo, type TypoFlag } from '../domain/typo-heuristic.js';
import type { BpMeasurementRepository } from './ports/bp-measurement-repository.js';

/** Миллисекунды в сутках: пересчёт TYPO_WINDOW_DAYS в окно listByPeriod (§5). */
const MS_PER_DAY = 86_400_000;
/** Глубина истории TypoHeuristic (§5: «лимит 100» — TASK-018 §78: массив ≤100). */
const TYPO_HISTORY_LIMIT = 100;
/** Глубина recent DuplicateDetector (§5: «recent 10» — TASK-019 §46). */
const DUPLICATE_RECENT_LIMIT = 10;

/** Минимальная поверхность шины событий для use case (§7: подстановочная в тестах). */
export interface AddMeasurementEvents {
  emit<K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]): void;
}

/** Минимальная поверхность логгера use case (§18); HlLogger контейнера ей удовлетворяет. */
export interface AddMeasurementLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах. */
export interface AddMeasurementDeps {
  readonly repo: BpMeasurementRepository;
  readonly clock: Clock;
  readonly events: AddMeasurementEvents;
  readonly logger: AddMeasurementLogger;
}

/** Флаги эвристик ответа (§7): typo — подсказка, duplicate — факт, critical — триггер панели. */
export interface AddMeasurementFlags {
  readonly typo?: TypoFlag;
  readonly duplicate: boolean;
  readonly criticalValue: CriticalFlag;
}

/** Результат успешного выполнения (§7): DTO канала + флаги. */
export interface AddResult {
  readonly measurement: MeasurementDto;
  readonly flags: AddMeasurementFlags;
}

/**
 * Маппинг агрегата → плоская форма DTO канала (TASK-028 §7): bp расплющен в sys/dia,
 * Instant — в пару takenAtUtcMs/tzOffsetMin. Опциональные поля (pulse/note) включаются
 * в объект только при наличии — чистая форма по проводам. Реэкспортируется для
 * следующих use case'ов журнала (TASK-030/037 — тот же DTO).
 */
export function toMeasurementDto(m: BpMeasurement): MeasurementDto {
  return {
    id: m.id,
    profileId: m.profileId,
    sys: m.bp.sys,
    dia: m.bp.dia,
    ...(m.pulse !== undefined ? { pulse: m.pulse } : {}),
    irregularPulse: m.irregularPulse,
    arm: m.arm,
    ...(m.note !== undefined ? { note: m.note } : {}),
    takenAtUtcMs: m.takenAt.utcMs,
    tzOffsetMin: m.takenAt.tzOffsetMin,
    source: m.source,
    createdAtUtcMs: m.createdAtUtc,
    updatedAtUtcMs: m.updatedAtUtc,
  };
}

/** Метки флагов для лога §18: `flags=[typo,duplicate,critical-high]` — без значений. */
function flagLabels(flags: AddMeasurementFlags): string[] {
  const labels: string[] = [];
  if (flags.typo !== undefined) {
    labels.push('typo');
  }
  if (flags.duplicate) {
    labels.push('duplicate');
  }
  if (flags.criticalValue !== undefined) {
    labels.push(`critical-${flags.criticalValue}`);
  }
  return labels;
}

/** Use case UC-01 (§5): execute(cmd) → Result<AddResult>. */
export class AddMeasurementUseCase {
  constructor(private readonly deps: AddMeasurementDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, исключения не пересекают слои. */
  async execute(cmd: CreateMeasurementCommand): Promise<Result<AddResult, AppError>> {
    const startedAtMs = performance.now();

    // 1. Домен (§9): валидация и сборка агрегата с Clock; err наружу, БД не трогается.
    const created = BpMeasurement.create(cmd, this.deps.clock);
    if (isErr(created)) {
      this.deps.logger.debug('addMeasurement: домен отклонил ввод', { code: created.error.code });
      return err(created.error);
    }
    const measurement = created.value;

    // 2. История (§9: после валидации, до сохранения). Окно typo — от МОМЕНТА
    //    кандидата (TASK-018 §46), recent — окно дубля вокруг кандидата (см. шапку).
    const takenAtUtcMs = measurement.takenAt.utcMs;
    const typoHistory = await this.deps.repo.listByPeriod({
      profileId: cmd.profileId,
      fromUtcMs: takenAtUtcMs - TYPO_WINDOW_DAYS * MS_PER_DAY,
      toUtcMs: takenAtUtcMs,
      limit: TYPO_HISTORY_LIMIT,
    });
    const recent = await this.deps.repo.listByPeriod({
      profileId: cmd.profileId,
      fromUtcMs: takenAtUtcMs - DUPLICATE_WINDOW_MS,
      toUtcMs: takenAtUtcMs + DUPLICATE_WINDOW_MS,
      limit: DUPLICATE_RECENT_LIMIT,
    });

    // 3. Флаги — чистые функции домена (§5): эвристики кандидата и критичность.
    const candidate = { sys: measurement.bp.sys, dia: measurement.bp.dia };
    const flags: AddMeasurementFlags = {
      typo: detectTypo(typoHistory, candidate),
      duplicate: detectDuplicate(recent, { ...candidate, utcMs: takenAtUtcMs }),
      criticalValue: assessCritical(candidate.sys, candidate.dia),
    };

    // 4. Сохранение (§9): упало (STORAGE/*) → err + лог, событий нет.
    const added = await this.deps.repo.add(measurement);
    if (isErr(added)) {
      this.deps.logger.error('addMeasurement: сохранение не удалось', {
        code: added.error.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: added.error };
    }

    // 5. События — только после успешного add, всегда оба (§11): newVersion —
    //    контракт порта TASK-021 (data_version+1 атомарно с записью).
    const newVersion = await this.deps.repo.currentDataVersion();
    this.deps.events.emit('measurement:changed', { profileId: measurement.profileId });
    this.deps.events.emit('data:versionBumped', { newVersion });

    // 6. Лог (§18): длительность и метки флагов — без значений (PHI, TASK-010).
    this.deps.logger.info('addMeasurement', {
      durationMs: Math.round(performance.now() - startedAtMs),
      flags: flagLabels(flags),
    });

    return ok({ measurement: toMeasurementDto(measurement), flags });
  }
}
