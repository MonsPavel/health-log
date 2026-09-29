// TASK-075 §19/§20: сеть мимо гейтвея запрещена линтером (D11, арх. 08 §5) —
// импорт node:https вне каталога egress ОБЯЗАН давать error (no-restricted-imports).
import { request } from 'node:https';

export const netRequest = request;
