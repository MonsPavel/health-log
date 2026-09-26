/**
 * TASK-030 §2/§5: use case ListMeasurements — тонкое чтение журнала (US-7, второй
 * по частоте экран): выборка записей страницы + total для счётчика «N измерений» и
 * пагинации UI (§3). «Тонкость» — осознанная (§4): доменных правил у list нет, use
 * case существует для единообразия регистрации хендлеров и будущего кэширования;
 * сортировка и фильтры — контракт порта (listByPeriod: takenAt desc, tie-break id
 * desc, §13).
 *
 * НОРМАЛИЗАЦИЯ ЗАПРОСА (§5/§13) — тихая, без ошибок:
 *  - limit: undefined → 200 (дефолт страницы); >500 → 500 + debug-лог (clamp, §13);
 *    отрицательный → 0 (пустая страница, а не «без ограничения»: SQLite-диалект
 *    молча опускает отрицательный LIMIT — без нормализации fake и адаптер разошлись
 *    бы; schema канала уже отсекает min(0), это защита прямых вызовов);
 *  - offset: undefined → 0; отрицательный → 0 (§13).
 * Схема канала TASK-028 дефолтит limit/offset на границе IPC — здесь те же дефолты
 * для прямых вызовов use case'а (тесты §19 проверяют именно use case).
 *
 * TOTAL (§7): countByPeriod по тем же фильтрам, БЕЗ limit/offset — счётчик считает
 * ВСЕ подходящие записи (пагинация UI), а не размер страницы; ключи пагинации в
 * запрос счёта не передаются вовсе (контракт порта: игнорируются, здесь — не
 * отправляются).
 *
 * ОТКАЗЫ (§9): доменных отказов нет — неуспех возможен только инфраструктурный.
 * Чтение портом ошибок не оборачивается (TASK-021 §7: «неуспех чтения контрактом
 * не определён») — execute возвращает страницу значением; необработанное исключение
 * хранилища дошло бы до каркаса IPC (register-channel §13 п. 4 → APP/INTERNAL).
 *
 * ТЕЛЕМЕТРИЯ (§18): debug-лог длительности с total — без значений измерений
 * (PHI-правило, TASK-010).
 *
 * СОБЫТИЯ: read-path событий не публикует — инвалидация TanStack Query (ключ
 * ['measurements', profileId, фильтры], §12) происходит по событиям мутаций
 * (measurement:changed — TASK-029/037).
 */
import { performance } from 'node:perf_hooks';

import type { MeasurementDto } from '@hl/contracts';

import type {
  BpMeasurementRepository,
  MeasurementQuery,
} from './ports/bp-measurement-repository.js';
import { toMeasurementDto } from './add-measurement.js';

/** Дефолт страницы (§5): limit=200 — «200 записей DTO ≈ десятки КБ» ок для IPC (§15). */
export const DEFAULT_LIST_LIMIT = 200;

/** Максимум страницы (§5/§13): >500 — тихий clamp + debug-лог. */
export const MAX_LIST_LIMIT = 500;

/**
 * Минимальная поверхность логгера use case (§13/§18); HlLogger контейнера ей
 * удовлетворяет (прецедент AddMeasurementLogger).
 */
export interface ListMeasurementsLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах (fake-repo TASK-021). */
export interface ListMeasurementsDeps {
  readonly repo: BpMeasurementRepository;
  readonly logger: ListMeasurementsLogger;
}

/** Ответ use case (§5): страница DTO + total по тем же фильтрам — форма ответа канала. */
export interface MeasurementListPage {
  readonly items: MeasurementDto[];
  readonly total: number;
}

/** Use case UC-список (§5): execute(query) → страница {items, total}. */
export class ListMeasurementsUseCase {
  constructor(private readonly deps: ListMeasurementsDeps) {}

  /** Выполняет чтение (§5): нормализация запроса → выборка страницы + COUNT total. */
  async execute(query: MeasurementQuery): Promise<MeasurementListPage> {
    const startedAtMs = performance.now();

    // 1. Нормализация пагинации (§13): тихие дефолты и clamp.
    const requestedLimit = query.limit;
    let limit = requestedLimit ?? DEFAULT_LIST_LIMIT;
    if (limit > MAX_LIST_LIMIT) {
      this.deps.logger.debug('listMeasurements: limit обрезан до максимума', {
        requestedLimit,
        limit: MAX_LIST_LIMIT,
      });
      limit = MAX_LIST_LIMIT;
    }
    if (limit < 0) {
      limit = 0;
    }
    const offset = query.offset === undefined || query.offset < 0 ? 0 : query.offset;

    // 2. Фильтры — как пришли (совпадают со схемой канала TASK-028, §7); ключи
    //    пагинации — только в выборку страницы.
    const filters: MeasurementQuery = {
      profileId: query.profileId,
      ...(query.fromUtcMs !== undefined ? { fromUtcMs: query.fromUtcMs } : {}),
      ...(query.toUtcMs !== undefined ? { toUtcMs: query.toUtcMs } : {}),
      ...(query.arm !== undefined ? { arm: query.arm } : {}),
      ...(query.hasNote === true ? { hasNote: true } : {}),
    };

    // 3. Чтение (§9): страница (desc-порядок — порт) + total без пагинации (§7).
    const [items, total] = await Promise.all([
      this.deps.repo.listByPeriod({ ...filters, limit, offset }),
      this.deps.repo.countByPeriod(filters),
    ]);

    // 4. Маппинг DTO (§7): плоская форма канала; опционалы — только при наличии.
    // 5. Лог (§18): длительность и total — без значений (PHI).
    this.deps.logger.debug('listMeasurements', {
      durationMs: Math.round(performance.now() - startedAtMs),
      total,
    });

    return { items: items.map(toMeasurementDto), total };
  }
}
