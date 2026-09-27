// TASK-045 §13/§18/§19: юниты use case SearchNotes на подставном порте поиска
// (прецедент list-measurements.test.ts TASK-030). Матрица:
//  - нормализация запроса: trim; limit undefined → 50 (§2), >200 → 200 — тихо +
//    debug (§13), отрицательный → 0 (защита прямых вызовов, прецедент TASK-030);
//  - порт получает НОРМАЛИЗОВАННЫЙ запрос (trim + limit); сырой ввод — забота
//    схемы канала (≤100), санитизация MATCH — адаптера (§9);
//  - ответ {items: MeasurementDto[], query} (§7): плоский DTO + server-computed
//    critical (единый источник main, TASK-042 §9);
//  - телеметрия §18: debug 'notes/search' с durationMs/hits/queryLen — БЕЗ текста
//    запроса (PHI-правило);
//  - пустой результат — не ошибка (§11), отказов доменных нет (§9).
import { describe, expect, it, vi } from 'vitest';

import { FixedClock, unsafeUnwrap } from '@hl/kernel';

import { BpMeasurement } from '../domain/bp-measurement.js';
import type { NotesSearchQuery } from './ports/notes-search.js';
import { SearchNotesUseCase } from './search-notes.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — прецедент TASK-029/030. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const TZ = 180;
const MINUTE_MS = 60_000;

/** Запись через фабрику домена (единственный путь создания, TASK-017). */
const record = (
  utcMs: number,
  overrides: Partial<Parameters<typeof BpMeasurement.create>[0]> = {},
): BpMeasurement =>
  unsafeUnwrap(
    BpMeasurement.create(
      {
        profileId: 'profile-1',
        sys: 120,
        dia: 80,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs, tzOffsetMin: TZ },
        ...overrides,
      },
      new FixedClock(NOW_MS, TZ),
    ),
  );

/** Подставной порт: возвращает заданный список, запоминает запрос (§19). */
function makeFakePort(items: BpMeasurement[] = []): {
  searchNotes: (q: NotesSearchQuery) => Promise<BpMeasurement[]>;
  calls: NotesSearchQuery[];
} {
  const calls: NotesSearchQuery[] = [];
  return {
    calls,
    searchNotes: (q) => {
      calls.push(q);
      return Promise.resolve(items);
    },
  };
}

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

describe('SearchNotesUseCase — нормализация запроса (§13)', () => {
  it('limit не задан → порт получает limit=50 (§2); query тримируется', async () => {
    const port = makeFakePort();
    const useCase = new SearchNotesUseCase({ search: port, logger: makeLogger() });

    await useCase.execute({ query: '  болела голова  ' });

    expect(port.calls).toEqual([{ query: 'болела голова', limit: 50 }]);
  });

  it('limit >200 → порт получает 200 (clamp, §13); limit 300 → 200 (§11)', async () => {
    const port = makeFakePort();
    const useCase = new SearchNotesUseCase({ search: port, logger: makeLogger() });

    await useCase.execute({ query: 'кофе', limit: 300 });

    expect(port.calls).toEqual([{ query: 'кофе', limit: 200 }]);
  });

  it('отрицательный limit → 0 (защита прямых вызовов, прецедент TASK-030)', async () => {
    const port = makeFakePort();
    const useCase = new SearchNotesUseCase({ search: port, logger: makeLogger() });

    await useCase.execute({ query: 'кофе', limit: -5 });

    expect(port.calls).toEqual([{ query: 'кофе', limit: 0 }]);
  });
});

describe('SearchNotesUseCase — ответ и маппинг (§7)', () => {
  it('возвращает {items: MeasurementDto[], query}; critical — server-computed (TASK-042)', async () => {
    const fresh = record(NOW_MS - MINUTE_MS, { note: 'после кофе' });
    const critical = record(NOW_MS - 2 * MINUTE_MS, { note: 'голова болит', sys: 190, dia: 110 });
    const port = makeFakePort([fresh, critical]);
    const useCase = new SearchNotesUseCase({ search: port, logger: makeLogger() });

    const result = await useCase.execute({ query: 'голова' });

    expect(result.query).toBe('голова');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ id: fresh.id, sys: 120, dia: 80, note: 'после кофе' });
    expect(result.items[1]).toMatchObject({ id: critical.id, sys: 190, dia: 110, critical: 'high' });
    // Плоский DTO: агрегат наружу не уходит (маппинг — в main, §7).
    expect(result.items[0]).not.toHaveProperty('bp');
    expect(result.items[0]).not.toHaveProperty('takenAt');
  });

  it('пустой результат — значение, не ошибка (§11: мусорный запрос → {items: []})', async () => {
    const port = makeFakePort([]);
    const useCase = new SearchNotesUseCase({ search: port, logger: makeLogger() });

    const result = await useCase.execute({ query: '"*=' });

    expect(result.items).toEqual([]);
    expect(result.query).toBe('"*=');
  });
});

describe('SearchNotesUseCase — телеметрия (§18)', () => {
  it('debug notes/search с durationMs/hits/queryLen; текст запроса НЕ логируется (PHI)', async () => {
    const port = makeFakePort([record(NOW_MS - MINUTE_MS, { note: 'секретное слово' })]);
    const logger = makeLogger();
    const useCase = new SearchNotesUseCase({ search: port, logger });

    await useCase.execute({ query: 'секретное слово', limit: 10 });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.debug.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('notes/search');
    expect(meta['hits']).toBe(1);
    expect(meta['queryLen']).toBe('секретное слово'.length);
    expect(typeof meta['durationMs']).toBe('number');
    expect(JSON.stringify(meta)).not.toContain('секретное');
  });
});
