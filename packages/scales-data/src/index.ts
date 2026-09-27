/**
 * TASK-050: публичный API @hl/scales-data — офисная шкала ESC/ESH 2018 (SRS 04
 * табл. 4.1) как версионируемые данные (FR-4.5) и их типы. Пакет изолирован:
 * зависимостей нет (арх. 03 §4, depcruise packages-layering) — обновление шкалы
 * = правка данных, не логики (§3).
 */
import dataJson from './bp-office-esc2018.json' with { type: 'json' };

import type { ScaleData } from './schema.js';

export type { BpRange, ScaleCategory, ScaleCategoryCode, ScaleData } from './schema.js';

/**
 * Офисная шкала ESC/ESH 2018, версия 1.0.0. Приведение типа честно: вывод
 * resolveJsonModule не знает литеральных кодов категорий и readonly-глубины
 * контракта; рантайм-валидацию данных zod-схемой выполняет тест пакета (§4)
 * и повторит потребитель при чтении data_json (TASK-051).
 */
export const BP_OFFICE_ESC2018 = dataJson as ScaleData;
