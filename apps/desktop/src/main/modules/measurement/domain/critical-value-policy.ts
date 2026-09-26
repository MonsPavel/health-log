/**
 * TASK-020 §2/§7: CriticalValuePolicy — чистая функция критического значения
 * измерения. Правило (§7): high, если sys ≥ CRITICAL_HIGH_SYS (180) ∨
 * dia ≥ CRITICAL_HIGH_DIA (120); иначе low, если sys ≤ CRITICAL_LOW_SYS (90) ∨
 * dia ≤ CRITICAL_LOW_DIA (60); иначе флага нет. Границы включительно (§13: 180/119
 * → high, 179/120 → high, 90/60 → low, 89/80 → low, 120/61 → undefined). Комбинация
 * «∨» — любое из двух значений (§4). Одновременное срабатывание обоих правил
 * численно невозможно; смешанная пара (например, 180/60) даёт 'high' — приоритет
 * high задокументирован (§7, §3: реакция на криз — обязанность care, FR-7.4).
 *
 * Пульс не участвует (§13): сигнатура принимает только (sys, dia). Функция чистая
 * (§20): без чтения времени, профиля и побочных эффектов — O(1) (§15), вызывается
 * на каждый ввод и при отрисовке списков. Флаг — машиночитаемый триггер панели
 * срочной помощи (TASK-041) и пометок статистики (TASK-052), НЕ диагноз (§14);
 * в БД не хранится — вычисляется на лету (§8). Средняя тяжесть 140–180 не
 * классифицируется здесь — это шкала TASK-053 (§5).
 */
import {
  CRITICAL_HIGH_DIA,
  CRITICAL_HIGH_SYS,
  CRITICAL_LOW_DIA,
  CRITICAL_LOW_SYS,
} from './constants.js';

/**
 * Флаг критического значения (§5): 'high' — гипертонический криз, 'low' —
 * гипотензия, undefined — критического значения нет.
 */
export type CriticalFlag = 'high' | 'low' | undefined;

/**
 * Оценка критичности пары (sys, dia) (§2): 'high' при sys ≥ 180 ∨ dia ≥ 120,
 * иначе 'low' при sys ≤ 90 ∨ dia ≤ 60, иначе undefined. Приоритет high (§7).
 * Пороговые числа — только константы модуля constants (§20), литералов здесь нет.
 */
export function assessCritical(sys: number, dia: number): CriticalFlag {
  if (sys >= CRITICAL_HIGH_SYS || dia >= CRITICAL_HIGH_DIA) {
    return 'high';
  }
  if (sys <= CRITICAL_LOW_SYS || dia <= CRITICAL_LOW_DIA) {
    return 'low';
  }
  return undefined;
}
