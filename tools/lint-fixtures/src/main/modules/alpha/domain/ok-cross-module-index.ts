// TASK-003 §19: импорт публичного index.ts другого модуля РАЗРЕШЁН (§7 запрещает только
// импорт, обходящий index.ts). ОБЯЗАН быть чистым: ни ошибок, ни предупреждений.
import { betaApi } from '../../beta/index.ts';

export const pong: string = betaApi.ping();
