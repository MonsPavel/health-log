// TASK-003 (ревью, симметрия к ok-node-builtin): domain закрыт и для Node-библиотек —
// boundaries v7 классифицирует их с origin «core»; матрица арх. 03 §4 разрешает domain
// только @hl/kernel и type-only @hl/contracts. ОБЯЗАН давать error (boundaries/dependencies).
import { join } from 'node:path';

export const joinPath = join;
