/**
 * TASK-064 §5/§4: zod-схема JSON-слепка всех данных — МАСТЕР-ФОРМАТ (версионированный
 * публичный контракт, §2/§3: «данные, которые понятны навсегда» — страховка от потери
 * функциональности CSV и основа будущих миграций/интеграций: импорт пост-MVP FR-6.6,
 * синхронизация). Схема в contracts, потому что экспорт ОБЯЗАН проходить валидацию
 * собственной схемой (AC §20.1 — roundtrip-тест чтением реального экспорта).
 *
 * СОСТАВ (§5): корень {formatVersion, appVersion, createdAtUtc, counts, profiles,
 * measurements, prefs?, scales} —
 *  - formatVersion: 1 (§13: в MVP не меняется);
 *  - appVersion — версия приложения, создавшего слепок (прецедент BACKUP_MANIFEST);
 *  - createdAtUtc — момент создания, мс эпохи Unix (прецедент BackupManifest: то же
 *    имя поля = та же семантика; измерения внутри DTO несут takenAtUtcMs/tzOffsetMin);
 *  - counts — счётчики ИЗ ФАКТОВ (длины массивов, §9), не заявление;
 *  - profiles — [{id, name, createdAtUtc}]: профили, к которым относятся выгруженные
 *    измерения (слоепок профиль-скоупный — use case ExportJson(profileId), §5);
 *  - measurements — MeasurementDto (контракт TASK-028): переиспользование, НЕ новый
 *    формат (§7) — «пульс не измерен» = ключ pulse отсутствует (JSON не знает undefined);
 *  - prefs — Prefs (TASK-047); не настроены → ключ отсутствует (§13: undefined);
 *  - scales — [{code, version}]: АКТИВНЫЕ шкалы, только код/версия — сами данные
 *    шкал в комплекте приложения (§7, @hl/scales-data), дублировать их не нужно.
 *
 * ПРАВИЛО ЭВОЛЮЦИИ ФОРМАТА (§13): новые поля — ТОЛЬКО опциональные (старый читатель
 * читает новый слепок); ломающие изменения — formatVersion 2 + читатель обеих версий
 * (при появлении импорта, пост-MVP FR-6.6 — §5/§23). В MVP версия 1 не меняется.
 *
 * БЕЗОПАСНОСТЬ (§14): PHI в слепке ожидаема (выгрузка пользователя); секретов в БД
 * нет, и корень strict — посторонний (секретоподобный) ключ отвергается schema-тестом.
 *
 * Все объекты .strict() (§14, конвенция схем contracts); типы выводятся из схем
 * (z.infer, §23 — никакой ручной синхронизации).
 */
import { z } from 'zod';

import { MEASUREMENT_DTO_SCHEMA } from '../measurement/schemas.js';
import { PREFS_SCHEMA } from '../prefs/schemas.js';
import { SCALE_VERSION_SCHEMA } from '../scales.js';

/**
 * Версия мастер-формата (§5/§13): literal — слепок иной версии собственной схемой v1
 * отвергается (эволюция — новая версия схемы + читатель обеих, см. правило выше).
 */
export const JSON_SNAPSHOT_FORMAT_VERSION = 1;

/**
 * Профиль слепка (§5): идентификатор, человекочитаемое имя, момент создания в мс
 * эпохи (created_at_utc v1 — целое; «0» у seed-профиля валидно — миграция v1).
 */
export const JSON_SNAPSHOT_PROFILE_SCHEMA = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    createdAtUtc: z.number().int().min(0),
  })
  .strict();

/**
 * Ссылка на активную шкалу (§5/§7): только код/версия — данные шкалы поставляются
 * комплектом приложения (@hl/scales-data), слепок их не дублирует. Версия — семвер
 * (зеркало контракта шкал TASK-051).
 */
export const JSON_SNAPSHOT_SCALE_REF_SCHEMA = z
  .object({ code: z.string().min(1), version: SCALE_VERSION_SCHEMA })
  .strict();

/** Счётчики слепка (§5/§9): вычисляются из фактов (длины массивов), оба обязательны. */
export const JSON_SNAPSHOT_COUNTS_SCHEMA = z
  .object({
    measurements: z.number().int().min(0),
    profiles: z.number().int().min(0),
  })
  .strict();

/**
 * Корень мастер-формата (§5). Единственное опциональное поле — prefs (§13: «не
 * настроены» = ключ отсутствует; null формой не предусмотрен — отсутствие есть
 * отсутствие ключа). strict — тест-сверка списка корневых ключей (§14: секретов нет).
 */
export const JSON_SNAPSHOT_SCHEMA = z
  .object({
    formatVersion: z.literal(JSON_SNAPSHOT_FORMAT_VERSION),
    /** Версия приложения, создавшего слепок (граница 32 — прецедент BackupManifest). */
    appVersion: z.string().min(1).max(32),
    /** Момент создания, мс эпохи Unix (UTC). */
    createdAtUtc: z.number().int().min(0),
    /** Счётчики из фактов (§9): counts.measurements === measurements.length и т.д. */
    counts: JSON_SNAPSHOT_COUNTS_SCHEMA,
    /** Профили выгруженных измерений (слепок профиль-скоупный — §5). */
    profiles: z.array(JSON_SNAPSHOT_PROFILE_SCHEMA),
    /** Все измерения профиля в форме MeasurementDto (TASK-028, §7). */
    measurements: z.array(MEASUREMENT_DTO_SCHEMA),
    /** Настройки (TASK-047); отсутствуют → ключ отсутствует (§13). */
    prefs: PREFS_SCHEMA.optional(),
    /** Активные версии шкал (только код/версия — §7). */
    scales: z.array(JSON_SNAPSHOT_SCALE_REF_SCHEMA),
  })
  .strict();

/** Профиль слепка (§5). */
export type JsonSnapshotProfile = z.infer<typeof JSON_SNAPSHOT_PROFILE_SCHEMA>;

/** Ссылка на активную шкалу (§5). */
export type JsonSnapshotScaleRef = z.infer<typeof JSON_SNAPSHOT_SCALE_REF_SCHEMA>;

/** Счётчики слепка (§5). */
export type JsonSnapshotCounts = z.infer<typeof JSON_SNAPSHOT_COUNTS_SCHEMA>;

/** JSON-слепок данных — мастер-формат v1 (§2/§5). */
export type JsonSnapshot = z.infer<typeof JSON_SNAPSHOT_SCHEMA>;
