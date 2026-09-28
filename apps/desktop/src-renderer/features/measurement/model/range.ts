/**
 * TASK-046 §7/§13/§14 → TASK-057 §4/§6: конвертер и валидатор произвольного
 * периода ПЕРЕНЕСЕН в общий lib (src-renderer/lib/period.ts) — один паттерн
 * period по продукту (переиспользование журналом и экраном «Динамика»).
 * Файл оставлен точкой совместимости: реэкспорт утилит фильтров (§6 057) —
 * существующие импорты './range' работают без изменений; семантика держится
 * тестами range.test.ts (без правок).
 */
export {
  DAY_MS,
  MS_PER_MINUTE,
  parseIsoDate,
  parseRange,
  type CalendarDate,
  type ParseRangeResult,
  type RangeBounds,
  type RangeErrorKind,
} from '../../../lib/period';
