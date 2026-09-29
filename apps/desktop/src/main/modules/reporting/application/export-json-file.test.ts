// TASK-065 §5/§19: юниты use case ExportJsonFile — оркестрация «очередь → генерация
// (use case 064) → FileSaver». Паритет export-csv-file.test.ts, отличия:
//  - расширение .json и лог `export json` (§13/§18);
//  - содержимое файла — РОВНО json-строка use case 064.
import { describe, expect, it, vi, type Mock } from 'vitest';

import { FixedClock, unsafeUnwrap, type Result, type AppError } from '@hl/kernel';

import { EXPORT_FAILED_MESSAGE_KEY } from '../domain/constants.js';
import { ExportJsonUseCase, type ExportJsonSource } from './export-json.js';
import { ExportJsonFileUseCase } from './export-json-file.js';
import type { ExportFileResult, ExportFileSaver } from './ports/export-file-saver.js';
import { type ExportFileLogger, type FileOpRunner } from './export-file.js';

/** Фиксированное «сейчас» = 2026-09-25T16:00:00+03:00 (прецедент int-тестов 063/064). */
const NOW_MS = 1_790_341_200_000;
const TZ = 180;
const PROFILE = 'profile-1';

/** Подстановочный источник слепка: профиль + две записи (маппинг 064 проверяет сам). */
const makeSource = (): ExportJsonSource => ({
  getProfile: vi.fn(() => Promise.resolve({ id: PROFILE, name: 'Тест', createdAtUtc: 0 })),
  listMeasurements: vi.fn(() => Promise.resolve([])),
});

/** Шпион-логгер (типизированные Mock — прецедент export-csv.test.ts). */
const makeLogger = (): {
  debug: Mock<ExportFileLogger['debug']>;
  info: Mock<ExportFileLogger['info']>;
  error: Mock<ExportFileLogger['error']>;
} => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

/** Подставочный FileSaver с журналом вызова saveJson (§22: порт — мок-интерфейс). */
const makeSaver = (options?: {
  result?: ExportFileResult;
  failWith?: Error;
}): {
  saver: ExportFileSaver;
  saveJson: Mock<ExportFileSaver['saveJson']>;
} => {
  const saveJson = vi.fn<(defaultName: string, json: string) => Promise<ExportFileResult>>(() =>
    options?.failWith !== undefined
      ? Promise.reject(options.failWith)
      : Promise.resolve(
          options?.result ?? { path: 'C:/Users/me/health-log-export-20260925-1600.json' },
        ),
  );
  return {
    saver: { saveCsv: vi.fn(), saveJson, savePdf: vi.fn() },
    saveJson,
  };
};

/** Подставочная очередь — семантика FileOpQueue (боевой класс подставляет контейнер). */
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

const makeJsonUseCase = (
  source: ExportJsonSource = makeSource(),
  logger = makeLogger(),
): ExportJsonUseCase =>
  new ExportJsonUseCase({
    source,
    prefs: { getPrefs: () => Promise.resolve(undefined) },
    scales: { listActiveScales: () => Promise.resolve([]) },
    clock: new FixedClock(NOW_MS, TZ),
    appVersion: '0.0.0',
    logger,
  });

describe('ExportJsonFileUseCase — оркестрация экспорта JSON (TASK-065 §5)', () => {
  it('happy path: генерация 064 → saveJson(имя §13, содержимое 064) → ok({path}); лог §18 `export json`', async () => {
    // Эталон содержимого: тот же use case 064 напрямую.
    const expected = unsafeUnwrap(await makeJsonUseCase().execute(PROFILE));
    const logger = makeLogger();
    const { saver, saveJson } = makeSaver();
    const useCase = new ExportJsonFileUseCase({
      generate: makeJsonUseCase(),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger,
    });

    const result = await useCase.execute(PROFILE);

    expect(unsafeUnwrap(result)).toEqual({
      path: 'C:/Users/me/health-log-export-20260925-1600.json',
    });
    expect(saveJson).toHaveBeenCalledTimes(1);
    expect(saveJson).toHaveBeenCalledWith('health-log-export-20260925-1600.json', expected.json);
    const [message, meta] = vi.mocked(logger.info).mock.calls[0] ?? [];
    expect(message).toBe('export json');
    expect(meta?.['basename']).toBe('health-log-export-20260925-1600.json');
    expect(meta?.['count']).toBe(0);
    expect(JSON.stringify(meta)).not.toContain('C:/Users');
  });

  it('отмена диалога → ok({canceled: true}) — не ошибка (§7)', async () => {
    const { saver, saveJson } = makeSaver({ result: { canceled: true } });
    const useCase = new ExportJsonFileUseCase({
      generate: makeJsonUseCase(),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });

    await expect(useCase.execute(PROFILE)).resolves.toMatchObject({
      ok: true,
      value: { canceled: true },
    });
    expect(saveJson).toHaveBeenCalledTimes(1);
  });

  it('сбой генерации → err 064 как есть, saver НЕ вызывается; сбой записи → err EXPORT/FAILED', async () => {
    // Сбой чтения источника: err EXPORT/FAILED от 064, файл не пишется.
    const badSource: ExportJsonSource = {
      getProfile: () => Promise.reject(new Error('db locked')),
      listMeasurements: () => Promise.resolve([]),
    };
    const { saver: saverA, saveJson } = makeSaver();
    const generateFailure = await new ExportJsonFileUseCase({
      generate: makeJsonUseCase(badSource),
      saver: saverA,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    }).execute(PROFILE);
    expect(errOf(generateFailure).code).toBe('EXPORT/FAILED');
    expect(saveJson).not.toHaveBeenCalled();

    // Сбой записи: исключение saver → err EXPORT/FAILED (messageKey каталога, §17).
    const { saver: saverB } = makeSaver({ failWith: new Error('ENOSPC') });
    const writeFailure = await new ExportJsonFileUseCase({
      generate: makeJsonUseCase(),
      saver: saverB,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    }).execute(PROFILE);
    expect(errOf(writeFailure).code).toBe('EXPORT/FAILED');
    expect(errOf(writeFailure).messageKey).toBe(EXPORT_FAILED_MESSAGE_KEY);
  });

  it('пустой profileId → TypeError (dev-контракт скоупа, §14)', async () => {
    const { saver } = makeSaver();
    const useCase = new ExportJsonFileUseCase({
      generate: makeJsonUseCase(),
      saver,
      queue: makeFakeQueue(),
      clock: new FixedClock(NOW_MS, TZ),
      logger: makeLogger(),
    });

    await expect(useCase.execute('')).rejects.toThrow(TypeError);
  });
});
