// TASK-003 (ревью): main-процесс по арх. 03 §4 ОБЯЗАН использовать Node API (fs, path,
// better-sqlite3). Зона без node:* — только renderer (§7). ОБЯЗАН быть чистым: ни ошибок,
// ни предупреждений (регрессия: origin «core» не попадал под разрешение внешних модулей).
import { join } from 'node:path';

export const segments: string = join('a', 'b');
