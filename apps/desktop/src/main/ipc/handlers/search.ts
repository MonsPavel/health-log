/**
 * Хендлер канала `notes/search` (TASK-045 §5/§9/§11): FTS-поиск заметок (US-9,
 * арх. 05 §3). Слой тонкий, прецедент measurements.ts: zod-валидацию запроса делает
 * каркас TASK-008 до вызова хендлера, здесь — только вызов use case'а и вырезание
 * проводной формы ответа:
 *  - use case возвращает SearchResult {items, query} (§7); query наружу не идёт —
 *    ответ канала по схеме TASK-045: {items} (§11);
 *  - доменных отказов нет (§9): мусорный/пустой запрос use case отдаёт как
 *    {items: []} значением; неуспех возможен только инфраструктурный — необработанное
 *    исключение дошло бы до каркаса (register-channel §13 п. 4 → APP/INTERNAL).
 */
import type { NotesSearchResponse } from '@hl/contracts';
import type { NotesSearchRequest } from '@hl/contracts';

import { SearchNotesUseCase } from '../../modules/measurement/application/search-notes.js';

/**
 * Фабрика хендлера `notes/search`: use case инъекцируется контейнером (TASK-027).
 * Ответ — {items} по строгой схеме TASK-045 (§11); критичность записей проставлена
 * use case'ом (TASK-042 §9) и входит в items как поле DTO.
 */
export function createSearchNotesHandler(
  useCase: SearchNotesUseCase,
): (payload: NotesSearchRequest) => Promise<NotesSearchResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    return { items: result.items };
  };
}
