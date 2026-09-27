/**
 * TASK-045 §5/§7/§9/§11/§18: use case SearchNotes — поиск измерений по заметкам
 * (US-9: «после кофе», «болела голова»). Тонкое чтение поверх порта NotesSearchPort
 * (прецедент ListMeasurements TASK-030): доменных правил нет; вся специфика MATCH —
 * в адаптере (санитизация §9, LIKE-fallback §13).
 *
 * НОРМАЛИЗАЦИЯ ЗАПРОСА (§13) — тихая, без ошибок:
 *  - query: trim (пустой → адаптер вернёт [] — §9 «пустой/мусорный → пустой
 *    результат, не ошибка»; length — для queryLen телеметрии §18);
 *  - limit: undefined → 50 (дефолт страницы поиска §2/§11); >200 → 200 (clamp +
 *    debug, §11/§13; схема канала уже отсекает >200 — защита прямых вызовов);
 *    отрицательный → 0 (пустая выдача, прецедент TASK-030 §13).
 *
 * ОТВЕТ (§7): SearchResult {items: MeasurementDto[], query} — query нормализованный;
 * critical (TASK-042 §9) — server-computed поверх DTO, единый источник main.
 *
 * ОТКАЗЫ (§9/§11): доменных нет; инфраструктурные не ловятся — каркас IPC вернёт
 * APP/INTERNAL (register-channel §13 п. 4). Мусорный запрос ошибкой НЕ является.
 *
 * ТЕЛЕМЕТРИЯ (§18): debug `notes/search durationMs hits=N queryLen=M` — текст запроса
 * НЕ логируется (может содержать PHI-контекст).
 *
 * СОБЫТИЯ: read-path событий не публикует (прецедент TASK-030); инвалидация кэша
 * renderer — по событиям мутаций (ключ ['measurements','search',query], §12).
 */
import { performance } from 'node:perf_hooks';

import type { MeasurementDto } from '@hl/contracts';

import { assessCritical } from '../domain/critical-value-policy.js';
import type { BpMeasurement, NotesSearchPort } from './ports/notes-search.js';
import { toMeasurementDto } from './add-measurement.js';

/** Дефолт страницы поиска (§2/§11/§13): UI предупреждает «показаны первые 50». */
export const DEFAULT_SEARCH_LIMIT = 50;

/** Максимум страницы поиска (§11): clamp тихо + debug. */
export const MAX_SEARCH_LIMIT = 200;

/** Минимальная поверхность логгера use case (§18; HlLogger ей удовлетворяет). */
export interface SearchNotesLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): порт поиска + логгер (подстановка в тестах). */
export interface SearchNotesDeps {
  readonly search: NotesSearchPort;
  readonly logger: SearchNotesLogger;
}

/** Ответ use case (§7): форма ответа канала + нормализованный запрос. */
export interface SearchResult {
  readonly items: MeasurementDto[];
  readonly query: string;
}

/** Вход use case (§11): сырой запрос; limit опционален — нормализуется здесь. */
export interface SearchNotesInput {
  readonly query: string;
  readonly limit?: number;
}

/** Use case поиска (§5): execute({query, limit?}) → SearchResult. */
export class SearchNotesUseCase {
  constructor(private readonly deps: SearchNotesDeps) {}

  /** Выполняет поиск (§5): нормализация → порт → маппинг DTO + телеметрия. */
  async execute(input: SearchNotesInput): Promise<SearchResult> {
    const startedAtMs = performance.now();

    // 1. Нормализация (§13): query trim; limit дефолт/clamp.
    const query = input.query.trim();
    const requestedLimit = input.limit;
    let limit = requestedLimit ?? DEFAULT_SEARCH_LIMIT;
    if (limit > MAX_SEARCH_LIMIT) {
      this.deps.logger.debug('notes/search: limit обрезан до максимума', {
        requestedLimit,
        limit: MAX_SEARCH_LIMIT,
      });
      limit = MAX_SEARCH_LIMIT;
    }
    if (limit < 0) {
      limit = 0;
    }

    // 2. Поиск через порт (§9): мусорный/пустой запрос — [] значения, не ошибка.
    const matches: BpMeasurement[] = await this.deps.search.searchNotes({ query, limit });

    // 3. Маппинг DTO (§7) + critical (TASK-042 §9 — server-computed, источник main).
    const items = matches.map((m) => {
      const dto = toMeasurementDto(m);
      const critical = assessCritical(m.bp.sys, m.bp.dia);
      return critical === undefined ? dto : { ...dto, critical };
    });

    // 4. Телеметрия (§18): durationMs/hits/queryLen — без текста запроса (PHI).
    this.deps.logger.debug('notes/search', {
      durationMs: Math.round(performance.now() - startedAtMs),
      hits: items.length,
      queryLen: query.length,
    });

    return { items, query };
  }
}
