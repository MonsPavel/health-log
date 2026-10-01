/**
 * Хендлеры каналов `updates/*` (TASK-096 §5/§11) — слой тонкий, прецедент
 * ai-models.ts: zod-валидацию запроса делает каркас TASK-008 до вызова хендлера;
 * здесь — вызов UpdatesService. check/download идут за согласием и журналом
 * gateway (§4/§9): отказ согласия/политики — AppError NET/BLOCKED_BY_POLICY
 * наружу (конверт отказа каркаса); сетевая неудача — {status: 'error'} в конверте
 * УСПЕХА (исход проверки, не ошибка канала — §9 «не креш и не тост-спам»).
 * install — {restarting: true} (перезапуск делает updater) или отказ
 * UPD/NOT_READY без скачанного обновления (§13).
 */
import type {
  UpdatesCheckRequest,
  UpdatesDownloadRequest,
  UpdatesInstallRequest,
  UpdatesInstallResponse,
  UpdatesStatusResponse,
} from '@hl/contracts';

import type { UpdatesService } from '../../modules/platform-services/updates/updates-service.js';

/** Фабрика хендлера `updates/check` (§11): проверка за согласием (§9). */
export function createUpdatesCheckHandler(
  service: UpdatesService,
): (payload: UpdatesCheckRequest) => Promise<UpdatesStatusResponse> {
  return async () => service.check();
}

/** Фабрика хендлера `updates/download` (§5): загрузка под тем же согласием. */
export function createUpdatesDownloadHandler(
  service: UpdatesService,
): (payload: UpdatesDownloadRequest) => Promise<UpdatesStatusResponse> {
  return async () => service.download();
}

/** Фабрика хендлера `updates/install` (§5): установка по кнопке; без ready — UPD/NOT_READY (§13). */
export function createUpdatesInstallHandler(
  service: UpdatesService,
): (payload: UpdatesInstallRequest) => Promise<UpdatesInstallResponse> {
  return async () => service.install();
}
