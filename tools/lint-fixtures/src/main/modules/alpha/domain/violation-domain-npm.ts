// TASK-003 §19: domain импортирует внешний npm — ОБЯЗАН давать error.
// Матрица арх. 03 §4: domain импортирует только @hl/kernel и type-only @hl/contracts.
// Ожидаемое правило: boundaries/external.
import { debounce } from 'lodash';

export const slow = debounce;
