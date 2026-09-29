// TASK-065 §5/§19: юниты use case ExportCsvFile — оркестрация «очередь → генерация
// (use case 063) → FileSaver». Матрица:
//  - happy path (§5): генерация → saver.saveCsv(defaultName, csv) → ok({path});
//    содержимое файла — РОВНО то, что собрал use case 063 (§19 хендлеров);
//  - имя по умолчанию (§13/§20): health-log-export-YYYYMMDD-HHmm.csv, ЛОКАЛЬНОЕ
//    время порта Clock (FixedClock), паддинг нулями;
//  - §18: info-лог `export csv` {basename, count, durationMs} — только basename
//    (полный путь содержит имя Windows-пользователя, §18/§14);
//  - отмена диалога (§7): saver → {canceled: true} → ok-ветка без лога успеха;
//  - сбой генерации (§9): err внешнего use case проходит как есть, saver НЕ зовётся;
//  - сбой записи (§10/§20): исключение saver → err EXPORT/FAILED (details в cause),
//    error-лог; очередь ЖИВАЯ — следующая операция выполняется (§20);
//  - сериализация (§13): вторая операция ждёт завершения первой (порядок событий);
//  - пустой profileId (§14): TypeError внутренних use case'ов доходит до вызвавшего.
import { describe, expect, it, vi, type Mock } from 'vitest';

import { FixedClock, unsafeUnwrap, type Result, type AppError } from '@hl/kernel';

import { EXPORT_FAILED_MESSAGE_KEY } from '../domain/constants.js';
import { toCsv, type ExportRow } from '../domain/csv.js';
import { ExportCsvUseCase, type ExportCsvSource } from './export-csv.js';
import { ExportCsvFileUseCase, type ExportFileLogger } from './export-csv-file.js';
import type { ExportFileResult, ExportFileSaver } from './ports/export-file-saver.js';
import type { FileOpRunner } from './export-file.js';

/** Фиксированное «сейчас» = 2026-09-25T16:00:00+03:00 (прецедент int-тестов 063/064). */
const NOW_MS = 1_790_341_200_000;
const TZ = 180;
const PROFILE = 'profile-1';

/** Момент в UTC+0 на 2026-01-02T03:04 — для теста паддинга имени (§13). */
const UTC_PAD_MS = 1_767_323_040_000;

/** Строка экспорта — фабрика фикстур (одна запись,asc-порядок тривиален). */
const row = (i: number): ExportRow => ({
  id: `id-${i}`,
  profileId: PROFILE,
  datetime: '2026-09-24T08:12:00+03:00',
  sys: 120,
  dia: 80,
  pulse: 72,
  irregular: false,
  arm: 'left',
  note: undefined,
  source: 'manual',
});

/** Подставочный источник: одна пачка в контракте репозитория — takenAt desc (063 развернёт). */
const makeSource = (rows: ExportRow[]): ExportCsvSource => ({
  listBatch: vi.fn((_profileId: string, offset: number, limit: number) =>
    Promise.resolve(offset === 0 ? [...rows].reverse().slice(0, limit) : []),
  ),
});

/** Шпион-логгер (типизированные Mock — прецедент export-csv.test.ts). */
const makeLogger = (): {
  debug: Mock<ExportFileLogger['debug']>;
  info: Mock<ExportFileLogger['info']>;
  error: Mock<ExportFileLogger['error']>;
} => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

/**
 * Подставочный FileSaver (§22: «мок-интерфейс FileSaver — порт, тестируется чисто»):
 * фиксированный результат, журнал вызовов; режим fail — исключение записи (§10).
 */
const makeSaver = (options?: { result?: ExportFileResult; failWith?: Error }): {
  saver: ExportFileSaver;
  saveCsv: Mock<ExportFileSaver['saveCsv']>;
} => {
  const saveCsv = vi.fn<(defaultName: string, csv: string) => Promise<ExportFileResult>>(
    (_defaultName: string, _csv: string) =>
      options?.failWith !== undefined
        ? Promise.reject(options.failWith)
        : Promise.resolve(options?.result ?? { path: 'C:/Users/me/health-log-export-20260925-1600.csv' }),
  );
  return {
    saver: { saveCsv, saveJson: vi.fn(), savePdf: vi.fn() },
    saveCsv,
  };
};

/**
 * Подставочная очередь с семантикой FileOpQueue (promise-хвост, §5): тесты оркестратора
 * не импортируют чужой модуль data-care — боевой класс подставляется контейнером,
 * его собственные §19-юниты — file-op-queue.test.ts.
 */
const makeFakeQueue = (): FileOpRunner => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(operation: () => Promise<T>): Promise<T> => {
      const enqueued = tail.then(operation, operation);
      tail = enqueued.then(
        () => undefined,
        () => undefined,
      );
      return enqueued;
    },
  };
};

const errOf = (result: Result<ExportFileResult, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидалась err-ветка Result, получена ok');
  }
  return result.error;
};

describe('ExportCsvFileUseCase — оркестрация экспорта CSV (TASK-065 §5)', () => {
  it('happy path: генерация → saveCsv(имя §13, содержимое 063) → ok({path}); лог §18 — basename без полного пути', async () => {
    const rows = [row(1)];
    const clock = new FixedClock(NOW_MS, TZ);
    // Эталон содержимого: тот же use case 063 напрямую (§19: файл == собранному).
    const expected = unsafeUnwrap(
      await new ExportCsvUseCase({ source: makeSource(rows), logger: makeLogger() }).execute(PROFILE),
    );
    const logger = makeLogger();
    const { saver, saveCsv } = makeSaver();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource(rows), logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock,
      logger,
    });

    const result = await useCase.execute(PROFILE);

    expect(result.ok).toBe(true);
    expect(unsafeUnwrap(result)).toEqual({
      path: 'C:/Users/me/health-log-export-20260925-1600.csv',
    });
    expect(saveCsv).toHaveBeenCalledTimes(1);
    expect(saveCsv).toHaveBeenCalledWith('health-log-export-20260925-1600.csv', expected.csv);
    // §18: info `export csv` {basename, count, durationMs} — путь только basename.
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.info.mock.calls[0] ?? ['', {}];
    expect(message).toBe('export csv');
    expect(meta).toMatchObject({ basename: 'health-log-export-20260925-1600.csv', count: 1 });
    expect(typeof (meta as { durationMs?: unknown }).durationMs).toBe('number');
    expect(JSON.stringify(meta)).not.toContain('C:/Users');
  });

  it('имя по умолчанию: паддинг нулями, локальное время порта Clock (§13/§20 AC5)', async () => {
    const { saver, saveCsv } = makeSaver();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource([]), logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(UTC_PAD_MS, 0),
      logger: makeLogger(),
    });

    await useCase.execute(PROFILE);

    expect(saveCsv.mock.calls[0]?.[0]).toBe('health-log-export-20260102-0304.csv');
  });

  it('отмена диалога → ok({canceled: true}) — не ошибка (§7); лог успеха не пишется', async () => {
    const { saver, saveCsv } = makeSaver({ result: { canceled: true } });
    const logger = makeLogger();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource([row(1)]), logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger,
    });

    const result = await useCase.execute(PROFILE);

    expect(unsafeUnwrap(result)).toEqual({ canceled: true });
    expect(saveCsv).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('сбой генерации → err внешнего use case проходит как есть; saver НЕ вызывается', async () => {
    const source: ExportCsvSource = {
      listBatch: () => Promise.reject(new Error('db locked')),
    };
    const { saver, saveCsv } = makeSaver();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source, logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });

    const result = await useCase.execute(PROFILE);

    expect(errOf(result).code).toBe('EXPORT/FAILED');
    expect(saveCsv).not.toHaveBeenCalled();
  });

  it('сбой записи (диск/права) → err EXPORT/FAILED + error-лог; очередь живая — следующая операция выполняется (§20)', async () => {
    const { saver } = makeSaver({ failWith: new Error('EACCES: read-only') });
    const logger = makeLogger();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource([row(1)]), logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger,
    });

    const failed = await useCase.execute(PROFILE);
    expect(errOf(failed).code).toBe('EXPORT/FAILED');
    expect(errOf(failed).messageKey).toBe(EXPORT_FAILED_MESSAGE_KEY);

    // Очередь не сломана: второй вызов с рабочим saver'ом успешен (§20).
    const okSaver = makeSaver();
    const useCase2 = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource([row(1)]), logger: makeLogger() }),
      saver: okSaver.saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });
    await expect(useCase2.execute(PROFILE)).resolves.toMatchObject({
      ok: true,
      value: { path: 'C:/Users/me/health-log-export-20260925-1600.csv' },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ code: 'EXPORT/FAILED' });
  });

  it('сериализация §13: saveCsv второй операции — строго ПОСЛЕ завершения saveCsv первой', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBatch = new Promise<ExportRow[]>((resolve) => {
      releaseFirst = () => resolve([row(1)]);
    });

    const slowSource: ExportCsvSource = {
      listBatch: vi.fn((_profileId: string, offset: number, limit: number) =>
        offset === 0 ? firstBatch : Promise.resolve([]),
      ),
    };
    const saverA: ExportFileSaver = {
      saveCsv: vi.fn((_n: string, _c: string) => {
        events.push('save1');
        return Promise.resolve({ path: 'C:/a.csv' });
      }),
      saveJson: vi.fn(),
      savePdf: vi.fn(),
    };
    const saverB: ExportFileSaver = {
      saveCsv: vi.fn((_n: string, _c: string) => {
        events.push('save2');
        return Promise.resolve({ path: 'C:/b.csv' });
      }),
      saveJson: vi.fn(),
      savePdf: vi.fn(),
    };
    // Очередь ОБЩАЯ (§9: инстанс один в контейнере — обе операции конкурируют на ней).
    const queue = makeFakeQueue();
    const deps = (source: ExportCsvSource, saver: ExportFileSaver) => ({
      generate: new ExportCsvUseCase({ source, logger: makeLogger() }),
      saver,
      queue,
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });

    const first = new ExportCsvFileUseCase(deps(slowSource, saverA)).execute(PROFILE);
    const second = new ExportCsvFileUseCase(deps(makeSource([row(2)]), saverB)).execute(PROFILE);

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]); // первая генерация ещё в полёте — ничего не сохранено

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['save1', 'save2']); // §13: вторая ждала первой
  });

  it('пустой profileId → TypeError (dev-контракт скоупа, §14) — до записи файла', async () => {
    const { saver, saveCsv } = makeSaver();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource([row(1)]), logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });

    await expect(useCase.execute('')).rejects.toThrow(TypeError);
    expect(saveCsv).not.toHaveBeenCalled();
  });

  it('toCsv-эталон: содержимое — BOM+заголовок домена 063 (содержимое файла == golden, §20)', async () => {
    const rows = [row(1), row(2)];
    const { saver, saveCsv } = makeSaver();
    const useCase = new ExportCsvFileUseCase({
      generate: new ExportCsvUseCase({ source: makeSource(rows), logger: makeLogger() }),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });

    await useCase.execute(PROFILE);

    expect(saveCsv.mock.calls[0]?.[1]).toBe(toCsv([row(1), row(2)]));
  });
});
