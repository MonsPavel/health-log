// TASK-063 §19: юниты use case ExportCsv на подстановочном источнике (порт
// ExportCsvSource — зеркала пачки listByPeriod). Матрица:
//  - пачки по 1000 (§5): offsets 0/1000/2000, стоп на неполной пачке; конкатенация;
//  - порядок в CSV — takenAt asc (§13), хотя источник отдаёт пачки в контракте
//    репозитория (takenAt desc) — use case разворачивает;
//  - пустой журнал → валидный CSV с заголовком и count=0, НЕ ошибка (§9/§20);
//  - сбой источника (чтение не определено Result-контрактом — TASK-021 §7) →
//    err EXPORT/FAILED значением Result (§5), error-лог;
//  - пустой profileId → программная ошибка TypeError (dev-контракт порта repo
//    TASK-021, принудительный скоуп арх. 08 §3);
//  - лог §18: info `exportCsv` {count, durationMs} — без значений измерений (PHI).
import { describe, expect, it, vi } from 'vitest';

import { unsafeUnwrap, type Result, type AppError } from '@hl/kernel';

import { toCsv, type ExportRow } from '../domain/csv.js';
import { EXPORT_BATCH_SIZE, ExportCsvUseCase, type ExportCsvSource } from './export-csv.js';

/** База моментов фикстур: 2026-09-24T05:12:00Z (= 08:12:00+03:00, пример §5), шаг 1 минута. */
const BASE_MS = 1_790_226_720_000;
const TZ = 180;

/** Строка экспорта без спецсимволов — фабрика фикстур (asc-порядок по datetime). */
const row = (i: number): ExportRow => ({
  id: `id-${i}`,
  profileId: 'profile-1',
  datetime: new Date(BASE_MS + i * 60_000).toISOString(),
  sys: 120,
  dia: 80,
  pulse: 72,
  irregular: false,
  arm: 'left',
  note: undefined,
  source: 'manual',
});

/** Найден err-индекс?.. нет — Extract err-ветку для assert'ов; ok — ошибка теста. */
const errOf = (result: Result<{ csv: string; count: number }, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидалась err-ветка Result, получена ok');
  }
  return result.error;
};

/**
 * Подстановочный источник с семантикой репозитория TASK-021 §13: пачки по (offset,
 * limit) в порядке takenAt desc (вход — asc-массив, источник сам разворачивает);
 * лог вызовов — для assert'ов пагинации.
 */
const makeDescSource = (rowsAsc: ExportRow[]): { source: ExportCsvSource; calls: { offset: number; limit: number }[] } => {
  const desc = [...rowsAsc].reverse();
  const calls: { offset: number; limit: number }[] = [];
  return {
    calls,
    source: {
      listBatch: vi.fn(async (_profileId: string, offset: number, limit: number) => {
        calls.push({ offset, limit });
        return desc.slice(offset, offset + limit);
      }),
    },
  };
};

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

const makeUseCase = (source: ExportCsvSource, logger = makeLogger()) => ({
  useCase: new ExportCsvUseCase({ source, logger }),
  logger,
});

describe('ExportCsvUseCase — сборка CSV (§5)', () => {
  it('5 записей → один вызов пачки (offset 0, limit 1000); csv = toCsv(asc); count=5', async () => {
    const rowsAsc = Array.from({ length: 5 }, (_, i) => row(i));
    const { source, calls } = makeDescSource(rowsAsc);
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute('profile-1');

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ offset: 0, limit: EXPORT_BATCH_SIZE }]);
    const { csv, count } = unsafeUnwrap(result);
    expect(csv).toBe(toCsv(rowsAsc));
    expect(count).toBe(5);
  });

  it('2500 записей → три пачки 0/1000/2000 (последняя неполная — стоп); порядок asc; count=2500 (§5/§13)', async () => {
    const rowsAsc = Array.from({ length: 2_500 }, (_, i) => row(i));
    const { source, calls } = makeDescSource(rowsAsc);
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute('profile-1');

    const { csv, count } = unsafeUnwrap(result);
    expect(calls).toEqual([
      { offset: 0, limit: EXPORT_BATCH_SIZE },
      { offset: 1_000, limit: EXPORT_BATCH_SIZE },
      { offset: 2_000, limit: EXPORT_BATCH_SIZE },
    ]);
    expect(count).toBe(2_500);
    // Хронология asc для врача (§13): первая строка данных — самая старая.
    const dataLines = csv.split('\r\n').slice(1);
    expect(dataLines[0]?.startsWith('id-0;')).toBe(true);
    expect(dataLines.at(-1)?.startsWith('id-2499;')).toBe(true);
  });

  it('ровно 1000 записей → вторая (пустая) пачка подтверждает конец; count=1000', async () => {
    const rowsAsc = Array.from({ length: 1_000 }, (_, i) => row(i));
    const { source, calls } = makeDescSource(rowsAsc);
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute('profile-1');

    const { count } = unsafeUnwrap(result);
    expect(calls).toEqual([
      { offset: 0, limit: EXPORT_BATCH_SIZE },
      { offset: 1_000, limit: EXPORT_BATCH_SIZE },
    ]);
    expect(count).toBe(1_000);
  });
});

describe('ExportCsvUseCase — пустой журнал и отказы (§9/§5)', () => {
  it('пустой журнал → ok: CSV только с заголовком, count=0 — не ошибка (§9/§20)', async () => {
    const { source } = makeDescSource([]);
    const { useCase } = makeUseCase(source);

    const result = await useCase.execute('profile-1');

    const { csv, count } = unsafeUnwrap(result);
    expect(count).toBe(0);
    expect(csv).toBe(toCsv([]));
  });

  it('сбой источника → err EXPORT/FAILED с messageKey errors.EXPORT_FAILED (§5); error-лог', async () => {
    const failingSource: ExportCsvSource = {
      listBatch: vi.fn(async () => {
        throw new Error('db gone');
      }),
    };
    const { useCase, logger } = makeUseCase(failingSource);

    const result = await useCase.execute('profile-1');

    const error = errOf(result);
    expect(error.code).toBe('EXPORT/FAILED');
    expect(error.messageKey).toBe('errors.EXPORT_FAILED');
    expect(logger.error).toHaveBeenCalledWith(
      'exportCsv: не удалось собрать выгрузку',
      expect.objectContaining({ code: 'EXPORT/FAILED' }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('пустой profileId → TypeError в точке вызова (dev-контракт скоупа, §14)', async () => {
    const { source } = makeDescSource([]);
    const { useCase } = makeUseCase(source);

    await expect(useCase.execute('')).rejects.toThrow(TypeError);
  });
});

describe('ExportCsvUseCase — телеметрия (§18)', () => {
  it('успех → info `exportCsv` {count, durationMs} — без значений измерений (PHI, TASK-010)', async () => {
    const rowsAsc = Array.from({ length: 3 }, (_, i) => row(i));
    const { source } = makeDescSource(rowsAsc);
    const { useCase, logger } = makeUseCase(source);

    await useCase.execute('profile-1');

    expect(logger.info).toHaveBeenCalledWith(
      'exportCsv',
      expect.objectContaining({ count: 3, durationMs: expect.any(Number) }),
    );
    const meta = vi.mocked(logger.info).mock.calls[0]?.[1] ?? {};
    expect(JSON.stringify(meta)).not.toContain('id-0');
  });
});
