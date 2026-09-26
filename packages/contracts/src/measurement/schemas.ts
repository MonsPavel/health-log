/**
 * TASK-028 §5/§11: zod-схемы каналов измерений `measurements/add|list|update|delete`.
 *
 * ДУБЛИРОВАНИЕ ГРАНИЦ ДОМЕНА — ОСОЗНАННОЕ (§4, арх. 03 §4): renderer не импортирует
 * main-домен, поэтому числа здесь повторяют константы модуля
 * apps/desktop/src/main/modules/measurement/domain/constants.ts (BP_LIMITS,
 * NOTE_MAX_LENGTH, TYPO_THRESHOLD-структура TypoFlag) и arm.ts (ARM_VALUES).
 * ПРАВКА ЧИСЛА ТАМ = СИНХРОННАЯ ПРАВКА ЗДЕСЬ; дрейф ловит синхронизационный
 * контракт-тест apps/desktop/src/main/modules/measurement/contracts-sync.test.ts
 * (§19, §22) — обязателен к прогону при любом изменении границ (см. комментарий
 * констант TASK-016).
 *
 * message проверок — КЛЮЧИ i18n-каталога, не тексты (§10/§16–17): errors.rangeSys,
 * errors.rangeDia, errors.rangePulse, errors.sysLeDia, errors.noteTooLong. Подстановки
 * (min/max/value) рендерер достаёт из полей zod-issue (minimum/maximum и path) —
 * потребители TASK-031. Ключ errors.futureTime в схеме не используется: «не будущее»
 * время схемой НЕ проверяется — вердикт домена TASK-017 (Clock), §13.
 *
 * Все объекты .strict() (§14: IPC-гигиена TASK-008, prototype-pollution). Ответные
 * схемы проверяют форму (целые, enum) — значения гарантированы доменом, диапазоны
 * здесь не дублируются.
 */
import { z } from 'zod';

/** Границы SRS FR-1.2 — синхронно с BP_LIMITS (domain/constants.ts, TASK-016). */
const SYS_MIN = 50;
const SYS_MAX = 300;
const DIA_MIN = 20;
const DIA_MAX = 200;
const PULSE_MIN = 20;
const PULSE_MAX = 300;
/** TASK-017 §5/§13 — синхронно с NOTE_MAX_LENGTH (domain/constants.ts). */
const NOTE_MAX = 500;
/** §13/§14: реальные смещения UTC−12…+14 → [-720, +840] минут. */
const TZ_OFFSET_MIN = -720;
const TZ_OFFSET_MAX = 840;
/** §14: длина id/профилей — простое ограничение, не uuid-regex (seed-profile-0001 валиден). */
const ID_MAX_LENGTH = 64;

/** Профиль-владелец: непустая строка ≤64 (§14 — принято ограничение длины вместо uuid-regex). */
const ProfileIdSchema = z.string().min(1).max(ID_MAX_LENGTH);

/** Идентификатор записи: uuid v7 (36 симв., генерирует агрегат TASK-017); ≤64 — IPC-гигиена §14. */
const MeasurementIdSchema = z.string().min(1).max(ID_MAX_LENGTH);

/** Рука измерения — синхронно с ARM_VALUES (domain/arm.ts, TASK-016: 'left' | 'right'). */
const ArmSchema = z.enum(['left', 'right']);

/**
 * Момент измерения {utcMs, tzOffsetMin} (kernel Instant, арх. 04 §2). utcMs — только
 * целое: ограничение «не будущее» в схеме ОТСУТСТВУЕТ осознанно (§13) — оно требует
 * Clock, его проверяет домен (MEASUREMENT/FUTURE_TIME, TASK-017).
 */
const TakenAtSchema = z
  .object({
    utcMs: z.number().int(),
    tzOffsetMin: z.number().int().min(TZ_OFFSET_MIN).max(TZ_OFFSET_MAX),
  })
  .strict();

/**
 * Измеримые поля add/update — зеркала CreateMeasurementCommand (TASK-017): sys/dia
 * целые 50–300 / 20–200, пульс опционален 20–300, note ≤500 ДО trim (схема строже
 * домена на whitespace-заметках — осознанно, §13 домена тримирует ДО проверки; на
 * подмножестве синхронизационного теста вердикты совпадают).
 */
const MeasurementFieldsSchema = z
  .object({
    sys: z
      .number()
      .int('errors.rangeSys')
      .min(SYS_MIN, 'errors.rangeSys')
      .max(SYS_MAX, 'errors.rangeSys'),
    dia: z
      .number()
      .int('errors.rangeDia')
      .min(DIA_MIN, 'errors.rangeDia')
      .max(DIA_MAX, 'errors.rangeDia'),
    pulse: z
      .number()
      .int('errors.rangePulse')
      .min(PULSE_MIN, 'errors.rangePulse')
      .max(PULSE_MAX, 'errors.rangePulse')
      .optional(),
    irregularPulse: z.boolean(),
    arm: ArmSchema,
    note: z.string().max(NOTE_MAX, 'errors.noteTooLong').optional(),
    takenAt: TakenAtSchema,
  })
  .strict();

/** Инвариант VO BloodPressure «строго sys > dia» (TASK-016) — на уровне объекта запроса. */
function withBpOrder<T extends z.ZodType<{ sys: number; dia: number }>>(schema: T): T {
  return schema.refine((v) => v.sys > v.dia, 'errors.sysLeDia');
}

/** §11: MeasurementAddRequest → запрос add. */
export const MEASUREMENT_ADD_REQUEST_SCHEMA = withBpOrder(
  z
    .object({
      profileId: ProfileIdSchema,
      ...MeasurementFieldsSchema.shape,
    })
    .strict(),
);

/** §5/§11: query list — зеркало MeasurementQuery порта TASK-021; limit/offset дефолтятся карманом. */
export const MEASUREMENT_LIST_REQUEST_SCHEMA = z
  .object({
    profileId: ProfileIdSchema,
    fromUtcMs: z.number().int().optional(),
    toUtcMs: z.number().int().optional(),
    arm: ArmSchema.optional(),
    hasNote: z.boolean().optional(),
    limit: z.number().int().min(0).default(200),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

/** §5/§11: запрос update — dto+id; измеримые поля и инварианты те же, что у add. */
export const MEASUREMENT_UPDATE_REQUEST_SCHEMA = withBpOrder(
  z
    .object({
      id: MeasurementIdSchema,
      ...MeasurementFieldsSchema.shape,
    })
    .strict(),
);

/** §5/§11: запрос delete — {id}. */
export const MEASUREMENT_DELETE_REQUEST_SCHEMA = z.object({ id: MeasurementIdSchema }).strict();

/**
 * §7: MeasurementDto — мгновенно-читаемая плоская форма агрегата BpMeasurement
 * (bp расплющен в sys/dia, takenAt — в takenAtUtcMs/tzOffsetMin). DTO ≠ агрегат:
 * маппинг — в main (адаптер контракта), renderer агрегат не видит. source —
 * MeasurementSource агрегата (TASK-017).
 */
export const MEASUREMENT_DTO_SCHEMA = z
  .object({
    id: z.string(),
    profileId: z.string(),
    sys: z.number().int(),
    dia: z.number().int(),
    pulse: z.number().int().optional(),
    irregularPulse: z.boolean(),
    arm: ArmSchema,
    note: z.string().optional(),
    takenAtUtcMs: z.number().int(),
    tzOffsetMin: z.number().int(),
    source: z.enum(['manual', 'import']),
    createdAtUtcMs: z.number().int(),
    updatedAtUtcMs: z.number().int(),
  })
  .strict();

/**
 * §5: TypoFlagDto — зеркало TypoFlag эвристики TASK-018 (median может быть *.5 при
 * чётной истории — число, не целое).
 */
export const MEASUREMENT_TYPO_FLAG_SCHEMA = z
  .object({
    field: z.enum(['sys', 'dia']),
    median: z.number(),
    value: z.number(),
    deviation: z.number(),
  })
  .strict();

/** Флаги эвристик ответа add (§5): подсказка typo, дубль TASK-019, критичность TASK-020. */
export const MEASUREMENT_FLAGS_SCHEMA = z
  .object({
    typo: MEASUREMENT_TYPO_FLAG_SCHEMA.optional(),
    duplicate: z.boolean().optional(),
    criticalValue: z.enum(['high', 'low']).optional(),
  })
  .strict();

/** §11: ответ add — {measurement, flags}. */
export const MEASUREMENT_ADD_RESPONSE_SCHEMA = z
  .object({ measurement: MEASUREMENT_DTO_SCHEMA, flags: MEASUREMENT_FLAGS_SCHEMA })
  .strict();

/** §11: ответ list — страница журнала (пагинация-курсор — аддитивное будущее, §23). */
export const MEASUREMENT_LIST_RESPONSE_SCHEMA = z
  .object({ items: z.array(MEASUREMENT_DTO_SCHEMA), total: z.number().int() })
  .strict();

/** §11: ответ update — {measurement}. */
export const MEASUREMENT_UPDATE_RESPONSE_SCHEMA = z
  .object({ measurement: MEASUREMENT_DTO_SCHEMA })
  .strict();

/** §11: ответ delete — {deleted: true}. */
export const MEASUREMENT_DELETE_RESPONSE_SCHEMA = z.object({ deleted: z.literal(true) }).strict();
