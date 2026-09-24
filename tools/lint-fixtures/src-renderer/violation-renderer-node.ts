// TASK-003 §19: renderer импортирует Node — ОБЯЗАН давать error.
// Зона renderer без Node (§7, арх. 08 §4). Ожидаемое правило: no-restricted-imports (node, node:*).
import { constants } from 'node:fs';

export const flags = constants;
