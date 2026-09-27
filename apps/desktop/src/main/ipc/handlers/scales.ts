/**
 * Хендлер канала `scales/active` (TASK-051 §5/§11): слой тонкий, прецедент
 * prefs.ts — zod-валидацию запроса делает каркас TASK-008 до вызова хендлера,
 * здесь — только делегирование ScaleService:
 *  - scales/active {} → полная форма ActiveScale {code, version, sourceLabel,
 *    categories, homeBPNote, specialGroupsNote} (контракт — scales.ts contracts);
 *  - отказы: STORAGE/CORRUPT (повреждение data_json/состояния — сервис, §7) и
 *    APP/INTERNAL (каркас). Ответ статический между запусками (§11) — кэш
 *    сервиса в памяти, рендерерский staleTime Infinity.
 */
import type { ScalesActiveRequest, ScalesActiveResponse } from '@hl/contracts';

import type { ScaleService } from '../../modules/analytics/application/scale-service.js';

/** Фабрика хендлера scales/active: сервис инъекцируется контейнером (TASK-027). */
export function createGetActiveScaleHandler(
  service: ScaleService,
): (payload: ScalesActiveRequest) => Promise<ScalesActiveResponse> {
  return async () => service.getActiveScale();
}
