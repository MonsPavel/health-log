/**
 * TASK-045 §4/§5: порт поиска по заметкам — application-слой (арх. 03 §4: адаптеры
 * импортируют только application-порты своего модуля). Реализация — SQLite-адаптер
 * FTS5 (adapters/notes-search.ts, TASK-045); подстановка в тестах — fake.
 *
 * Чтение — значения без Result (неуспех чтения контрактом не определён, прецедент
 * TASK-021 §7). Санитизация пользовательского ввода и выбор MATCH/LIKE —
 * инфраструктурная забота адаптера (§9/§13): порт принимает «сырой» запрос как есть.
 */
import type { BpMeasurement } from '../../domain/bp-measurement.js';

/**
 * Доменный тип в контракте порта. Реэкспорт обязателен: матрица арх. 03 §4 —
 * адаптер видит агрегат через порт, не domain (прецедент bp-measurement-repository.ts).
 */
export type { BpMeasurement };

/** Запрос поиска (§11/§13): сырой текст и лимит страницы. */
export interface NotesSearchQuery {
  /** Текст запроса как дал пользователь (до санитизации MATCH). */
  readonly query: string;
  /** Максимум записей результата (после сортировки desc). */
  readonly limit: number;
}

/** Порт FTS-поиска заметок (§5): запрос → записи, отсортированные по времени desc. */
export interface NotesSearchPort {
  searchNotes(q: NotesSearchQuery): Promise<BpMeasurement[]>;
}
