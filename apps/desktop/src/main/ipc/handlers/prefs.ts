/**
 * Хендлеры каналов `prefs/get|set` (TASK-047 §5/§11): слой тонкий, прецедент
 * search.ts — zod-валидацию запроса делает каркас TASK-008 до вызова хендлера
 * (prefs/set — schema strip: неизвестные ключи patch отбрасываются до сервиса),
 * здесь — только делегирование use case'у PreferencesService:
 *  - prefs/get {} → полный документ Prefs (дефолты/повреждение решает сервис, §8);
 *  - prefs/set {patch} → обновлённый ПОЛНЫЙ документ; отказы: VALIDATION/FAILED
 *    (невалидный patch — сервис, §11) и STORAGE/* (запись — адаптер, §9).
 */
import type {
  PrefsGetRequest,
  PrefsGetResponse,
  PrefsSetRequest,
  PrefsSetResponse,
} from '@hl/contracts';

import type { PreferencesService } from '../../modules/settings-profile/application/preferences-service.js';

/** Фабрика хендлера prefs/get: use case инъекцируется контейнером (TASK-027). */
export function createGetPrefsHandler(
  service: PreferencesService,
): (payload: PrefsGetRequest) => Promise<PrefsGetResponse> {
  return async () => service.getPrefs();
}

/** Фабрика хендлера prefs/set: patch валидирует сервис (merge, §9). */
export function createSetPrefsHandler(
  service: PreferencesService,
): (payload: PrefsSetRequest) => Promise<PrefsSetResponse> {
  return async (payload) => service.setPrefs(payload.patch);
}
