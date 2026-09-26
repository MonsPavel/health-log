/**
 * TASK-017 §2/§7: агрегат BpMeasurement — точка консистентности журнала. Создание
 * (create) и правка (edit) — только через фабрики, проверяющие все инварианты SRS
 * (FR-1.1): валидное давление/пульс (VO TASK-016), время не в будущем, заметка
 * ≤500 символов. Ограничение времени — только на будущее: ввод задним числом (US-3)
 * разрешён. Текущее время — исключительно через инъекционный Clock (§4: детерминизм
 * NFR-10 и корректность «не в будущем» относительно часов машины); прямое чтение
 * времени в domain запрещено (grep-критерий §24). Ошибки — Result<AppError>,
 * исключения не пересекают слои.
 *
 * Иммутабельность (§7): все поля readonly, edit пересобирает копию и не трогает
 * existing (deep-freeze §20). id — uuid v7 (зависимость uuid, §5): лексикографическая
 * сортировка id ≈ сортировка по времени создания (арх. 04 §2). Порядок валидации §7:
 * BloodPressure → Pulse → длина заметки → takenAt ≤ clock.nowMs() (равенство «сейчас»
 * валидно — допуск 0 мс). Конкурентность здесь не решается: дубли — TASK-019,
 * атомарность записи — TASK-026 (§13).
 */
import { v7 as uuidV7 } from 'uuid';

import { AppError, err, isErr, ok, type Clock, type Instant, type Result } from '@hl/kernel';

import type { Arm } from './arm.js';
import { BloodPressure } from './blood-pressure.js';
import {
  FUTURE_TIME_MESSAGE_KEY,
  NOTE_MAX_LENGTH,
  NOTE_TOO_LONG_MESSAGE_KEY,
} from './constants.js';
import type { CreateMeasurementCommand, EditMeasurementCommand } from './measurement-commands.js';
import { Pulse } from './pulse.js';

/** Источник записи: ручной ввод или импорт (§5: импорт post-MVP переиспользует create). */
export type MeasurementSource = 'manual' | 'import';

/** Валидное ядро измеримых полей — общий результат проверки для create и edit (§7). */
interface ValidatedFields {
  readonly bp: BloodPressure;
  readonly pulse: Pulse | undefined;
  readonly note: string | undefined;
}

/**
 * Инвариант «время не в будущее»: takenAt.utcMs ≤ nowMs; равенство валидно —
 * допуск 0 мс (§13). Ошибка MEASUREMENT/FUTURE_TIME без params (§16–17).
 */
function validateTakenAt(takenAt: Instant, nowMs: number): Result<void, AppError> {
  if (takenAt.utcMs > nowMs) {
    return err(AppError.of('MEASUREMENT/FUTURE_TIME', FUTURE_TIME_MESSAGE_KEY));
  }
  return ok(undefined);
}

/**
 * Валидация измеримых полей в порядке §7 (без времени): BloodPressure → Pulse →
 * длина заметки. Заметка тримируется ДО проверки длины: whitespace-заметка любой
 * длины — это «нет заметки» (§13), а не ошибка; пустая после trim → undefined.
 */
function validateFields(
  sys: number,
  dia: number,
  pulse: number | undefined,
  note: string | undefined,
): Result<ValidatedFields, AppError> {
  const bpResult = BloodPressure.create(sys, dia);
  if (isErr(bpResult)) {
    return err(bpResult.error);
  }
  const pulseResult = Pulse.create(pulse);
  if (isErr(pulseResult)) {
    return err(pulseResult.error);
  }
  const trimmed = note?.trim();
  const cleanNote = trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  if (cleanNote !== undefined && cleanNote.length > NOTE_MAX_LENGTH) {
    return err(
      AppError.of('MEASUREMENT/NOTE_TOO_LONG', NOTE_TOO_LONG_MESSAGE_KEY, { max: NOTE_MAX_LENGTH }),
    );
  }
  return ok({ bp: bpResult.value, pulse: pulseResult.value, note: cleanNote });
}

/**
 * Агрегат измерения артериального давления (арх. 02 §3.1). Единственный путь
 * создания объекта — фабрики create/edit: невалидное состояние (будущее время,
 * длинная заметка, неверное давление) непредставимо (§4).
 */
export class BpMeasurement {
  /** Приватный конструктор: инварианты проверяют фабрики. */
  private constructor(
    readonly id: string,
    readonly profileId: string,
    readonly bp: BloodPressure,
    readonly pulse: Pulse | undefined,
    readonly irregularPulse: boolean,
    readonly arm: Arm,
    readonly note: string | undefined,
    readonly takenAt: Instant,
    readonly source: MeasurementSource,
    readonly createdAtUtc: number,
    readonly updatedAtUtc: number,
  ) {}

  /**
   * Создаёт измерение: генерирует uuid v7 id, source = 'manual' (§5); штампы
   * createdAtUtc/updatedAtUtc = clock.nowMs() — одно чтение часов и на проверку
   * времени, и на штампы (согласованность takenAt ≈ createdAt).
   */
  static create(cmd: CreateMeasurementCommand, clock: Clock): Result<BpMeasurement, AppError> {
    const now = clock.nowMs();
    const fields = validateFields(cmd.sys, cmd.dia, cmd.pulse, cmd.note);
    if (isErr(fields)) {
      return err(fields.error);
    }
    const time = validateTakenAt(cmd.takenAt, now);
    if (isErr(time)) {
      return err(time.error);
    }
    return ok(
      new BpMeasurement(
        uuidV7(),
        cmd.profileId,
        fields.value.bp,
        fields.value.pulse,
        cmd.irregularPulse,
        cmd.arm,
        fields.value.note,
        cmd.takenAt,
        'manual',
        now,
        now,
      ),
    );
  }

  /**
   * Правка: пересобирает immutable-копию (§7) с наследованием id, profileId, source
   * и createdAtUtc; updatedAtUtc = clock.nowMs(). Инварианты пере проверяются
   * полностью — правка не может «испортить» запись в невалидное состояние.
   */
  static edit(
    existing: BpMeasurement,
    cmd: EditMeasurementCommand,
    clock: Clock,
  ): Result<BpMeasurement, AppError> {
    const now = clock.nowMs();
    const fields = validateFields(cmd.sys, cmd.dia, cmd.pulse, cmd.note);
    if (isErr(fields)) {
      return err(fields.error);
    }
    const time = validateTakenAt(cmd.takenAt, now);
    if (isErr(time)) {
      return err(time.error);
    }
    return ok(
      new BpMeasurement(
        existing.id,
        existing.profileId,
        fields.value.bp,
        fields.value.pulse,
        cmd.irregularPulse,
        cmd.arm,
        fields.value.note,
        cmd.takenAt,
        existing.source,
        existing.createdAtUtc,
        now,
      ),
    );
  }
}
