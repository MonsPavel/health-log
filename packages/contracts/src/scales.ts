/**
 * TASK-051 §5/§7/§11: zod-схемы канала `scales/active` (арх. 05 §3) и контракта
 * файла данных справочной шкалы. Данные — пакет @hl/scales-data (TASK-050):
 * депкruise packages-layering изолирует его от contracts, поэтому JSON-скелет
 * зеркалится здесь zod-ом (§4 TASK-050, РЕШЕНИЕ: «валидация схемы живёт в тестах
 * пакета и в потребителе TASK-051»); совместимость зеркала с опубликованными
 * типами пакета проверяет интеграционный тест ScaleService (desktop зависит от
 * пакета, contracts — нет).
 *
 * Канал маленький и статический между запусками (§5/§11): {} → полная форма
 * ActiveScale; кэш рендерера — staleTime Infinity, инвалидация не нужна в MVP.
 * Событие scales:changed при смене версии — НЕ в MVP (§5 — комментарий; форма
 * канала от этого не зависит).
 *
 * Все объекты .strict() (§14: IPC-гигиена TASK-008); типы выводятся из схем
 * (z.infer, §23 — никакой ручной синхронизации).
 */
import { z } from 'zod';

/**
 * Семвер данных шкалы (FR-4.5): обновление шкалы = новая запись версии, а не
 * логика (§3). Регэксп — тот же, что в zod-схеме пакета (TASK-050 test/schema).
 */
export const SCALE_VERSION_SCHEMA = z.string().regex(/^\d+\.\d+\.\d+$/);

/** Граница диапазона АД в мм рт. ст.; null — открытая сторона (§7 пакета). */
export const BP_RANGE_SCHEMA = z
  .object({ min: z.number().int().nullable(), max: z.number().int().nullable() })
  .strict();

/**
 * Категория шкалы: границы парами ПО КАЖДОМУ измерению (§7 пакета: «и/или»
 * табл. 4.1 — презентационная формулировка правила «категория = худшая из двух»;
 * машину классификации реализует TASK-053).
 */
export const SCALE_CATEGORY_SCHEMA = z
  .object({
    code: z.enum([
      'optimal',
      'normal',
      'high_normal',
      'hypertension1',
      'hypertension2',
      'hypertension3',
    ]),
    label: z.string().min(1),
    sysRange: BP_RANGE_SCHEMA,
    diaRange: BP_RANGE_SCHEMA,
  })
  .strict();

/**
 * Полный контракт файла данных шкалы (колонка data_json в reference_scale v4).
 * Точный JSON-скелет §7 пакета: язык зафиксирован ('ru' — данные v1.0.0 не
 * локализуемы, §17 TASK-050), категорий ровно 6, '$comment' — файловые
 * метаданные OQ-6 вне контракта данных. Сервис валидирует этой схемой data_json
 * ПРИ КАЖДОМ чтении (§7: повреждение — понятная ошибка STORAGE/CORRUPT-стиль +
 * лог, не тихий дефолт — шкала критична).
 */
export const SCALE_DATA_SCHEMA = z
  .object({
    code: z.string().min(1),
    version: SCALE_VERSION_SCHEMA,
    sourceLabel: z.string().min(1),
    language: z.literal('ru'),
    categories: z.array(SCALE_CATEGORY_SCHEMA).length(6),
    homeBPNote: z.string().min(1),
    specialGroupsNote: z.string().min(1),
    $comment: z.string().min(1).optional(),
  })
  .strict();

/** §5/§11: запрос scales/active — полный документ без параметров. */
export const SCALES_ACTIVE_REQUEST_SCHEMA = z.object({}).strict();

/**
 * §7: форма канала ActiveScale — проекция ВАЛИДИРОВАННОГО файла данных (language
 * и $comment на провод не нужны). Счётчик категорий формой НЕ дублируется: ровно
 * 6 проверяет SCALE_DATA_SCHEMA при чтении данных; форме достаточно непустого
 * списка (потребители 053/057 рисуют то, что отдала шкала).
 */
export const SCALES_ACTIVE_RESPONSE_SCHEMA = z
  .object({
    code: z.string().min(1),
    version: SCALE_VERSION_SCHEMA,
    sourceLabel: z.string().min(1),
    categories: z.array(SCALE_CATEGORY_SCHEMA).min(1),
    homeBPNote: z.string().min(1),
    specialGroupsNote: z.string().min(1),
  })
  .strict();

/** Файл данных шкалы (data_json после валидации) — структурно совместим с ScaleData пакета @hl/scales-data. */
export type ScaleDataFile = z.infer<typeof SCALE_DATA_SCHEMA>;

/** Активная шкала — форма канала `scales/active` (§7). */
export type ActiveScale = z.infer<typeof SCALES_ACTIVE_RESPONSE_SCHEMA>;

/** §11: запрос/ответ scales/active. */
export type ScalesActiveRequest = z.infer<typeof SCALES_ACTIVE_REQUEST_SCHEMA>;
export type ScalesActiveResponse = z.infer<typeof SCALES_ACTIVE_RESPONSE_SCHEMA>;
