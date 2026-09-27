/**
 * TASK-045 §5/§23: типы канала notes/search выводятся из zod-схем (z.infer) —
 * никакой ручной синхронизации. Потребители: SearchNotesUseCase и хендлер
 * notes/search (main), use-notes-search (renderer).
 */
import type { z } from 'zod';

import type { NOTES_SEARCH_REQUEST_SCHEMA, NOTES_SEARCH_RESPONSE_SCHEMA } from './schemas.js';

/** Запрос search (§11): {query ≤100, limit default 50}. */
export type NotesSearchRequest = z.infer<typeof NOTES_SEARCH_REQUEST_SCHEMA>;

/** Ответ search (§11): {items: MeasurementDto[]}. */
export type NotesSearchResponse = z.infer<typeof NOTES_SEARCH_RESPONSE_SCHEMA>;
