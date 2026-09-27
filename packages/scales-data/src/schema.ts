/**
 * TASK-050 §7: опубликованные типы файла данных справочной шкалы — точный
 * JSON-скелет контракта в форме TS. Zod-зеркало схемы живёт в тесте пакета
 * (test/schema.test.ts; §4, РЕШЕНИЕ: «валидация схемы живёт в тестах пакета
 * и в потребителе TASK-051») и проверено тип-тестом на совместимость с этими
 * типами — расхождение ловит компилятор/тест, а не прод.
 */

/** Диапазон АД в мм рт. ст., границы включительно; null — открытая сторона (§13). */
export interface BpRange {
  readonly min: number | null;
  readonly max: number | null;
}

/** Коды категорий офисной шкалы ESC/ESH 2018 — в порядке от оптимальной к тяжёлой. */
export type ScaleCategoryCode =
  'optimal' | 'normal' | 'high_normal' | 'hypertension1' | 'hypertension2' | 'hypertension3';

/**
 * Категория шкалы. Границы хранятся по каждому измерению ОТДЕЛЬНО (§7): «и/или»
 * таблицы 4.1 SRS — презентационная формулировка правила «категория = худшая из
 * двух»; машину классификации реализует TASK-053.
 */
export interface ScaleCategory {
  readonly code: ScaleCategoryCode;
  readonly label: string;
  /** Границы по систолическому давлению (СДА), мм рт. ст. */
  readonly sysRange: BpRange;
  /** Границы по диастолическому давлению (ДДА), мм рт. ст. */
  readonly diaRange: BpRange;
}

/** Файл данных справочной шкалы (FR-4.5: версионируемые данные с источником). */
export interface ScaleData {
  /** Код шкалы, например 'bp_office_esc2018'. */
  readonly code: string;
  /** Семвер данных; обновление шкалы = новая версия данных, а не логики (§3). */
  readonly version: string;
  /** Источник для показа пользователю, например 'ESC/ESH 2018'. */
  readonly sourceLabel: string;
  /** Язык labels и примечаний (§17: данные v1.0.0 не локализуемы). */
  readonly language: string;
  /** Категории в порядке от оптимальной к тяжёлой (§13). */
  readonly categories: readonly ScaleCategory[];
  /** Примечание о домашних порогах: среднее ≥135/85 ↔ офисные ≥140/90 (FR-4.2). */
  readonly homeBPNote: string;
  /** Дисклеймер о неприменимости порогов особым группам (FR-4.2). */
  readonly specialGroupsNote: string;
  /** Файловые метаданные вне контракта данных (OQ-6: «верифицировать первоисточник»). */
  readonly $comment?: string;
}
