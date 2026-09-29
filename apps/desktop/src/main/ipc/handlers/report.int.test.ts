// TASK-065 §19/§20: интеграционный тест хендлеров каналов экспорта — полный боевой
// путь по проводам каркаса TASK-008: dispatch(registry) → zod-валидация → хендлер →
// оркестрация (очередь → use case 063/064) → ElectronFileSaver (dialog MOCK — §19
// «отмена диалога (mock)»; запись writeFile — РЕАЛЬНАЯ, файл на диске в tmp).
//
// Покрывается (§19, §20):
//  - AC1: экспорт CSV — файл создан, содержимое РОВНО сборке use case 063 (байты);
//  - AC2: отмена диалога → ответ {canceled: true}, файл не создан, конверт ok;
//  - AC4: ошибка записи (несуществующий каталог) → конверт ok:false EXPORT/FAILED,
//    очередь ЖИВАЯ — следующая операция выполняется (§20);
//  - валидация схемы: пустой profileId → VALIDATION/FAILED, хендлер не зовётся;
//  - JSON-канал: файл создан, содержимое — валидный JSON-слепок (мастер-формат 064).
//
// РАСПОЛОЖЕНИЕ — src/main/ipc/handlers: тест сводит reporting + data-care (очередь)
// + platform (адаптер) — составу src/main прямой импорт внутренностей модулей
// разрешён (depcruise module-public-api; прецедент reporting-export-csv.int.test.ts).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import { FixedClock, unsafeUnwrap } from '@hl/kernel';

vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn() } }));

const { dialog } = await import('electron');
const showSaveDialog = vi.mocked(dialog.showSaveDialog);

import { FileOpQueue } from '../../modules/data-care/application/file-op-queue.js';
import { createChannelRegistry } from '../register-channel.js';
import { ElectronFileSaver } from '../../platform/file-saver.js';
import { ExportCsvUseCase, type ExportCsvSource } from '../../modules/reporting/application/export-csv.js';
import { ExportJsonUseCase, type ExportJsonSource } from '../../modules/reporting/application/export-json.js';
import { ExportCsvFileUseCase } from '../../modules/reporting/application/export-csv-file.js';
import { ExportJsonFileUseCase } from '../../modules/reporting/application/export-json-file.js';
import { createExportCsvHandler, createExportJsonHandler } from './report.js';

const NOW_MS = 1_790_341_200_000; // 2026-09-25T16:00:00+03:00
const TZ = 180;
const PROFILE = 'profile-1';
const silenceLogger = {
  debug: () => {},
  info: () => {},
  error: () => {},
};

/** Строка экспорта — фикстура (золотая заметка §20 TASK-063). */
const ROW = {
  id: 'id-1',
  profileId: PROFILE,
  datetime: '2026-09-24T08:12:00+03:00',
  sys: 128,
  dia: 82,
  pulse: 76,
  irregular: false,
  arm: 'left' as const,
  note: 'болит; голова "сильно"',
  source: 'manual' as const,
};

/** Эталон CSV: тот же use case 063 напрямую (сверка содержимого файла, §20 AC1). */
const csvSource: ExportCsvSource = {
  listBatch: (_profileId, offset, limit) =>
    Promise.resolve(offset === 0 ? [ROW].slice(0, limit) : []),
};

/** Источник слепка: без профиля (пустой слепок валиден, §9 064). */
const jsonSource: ExportJsonSource = {
  getProfile: () => Promise.resolve(undefined),
  listMeasurements: () => Promise.resolve([]),
};

describe('report/export-*: хендлеры → очередь → use case → saver (TASK-065 §19)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-report-handlers-int-'));

  const registry = createChannelRegistry();
  const queue = new FileOpQueue();
  const clock = new FixedClock(NOW_MS, TZ);
  const csvUseCase = new ExportCsvUseCase({ source: csvSource, logger: silenceLogger });
  registry.register(
    'report/export-csv',
    CHANNEL_SCHEMAS['report/export-csv'],
    createExportCsvHandler(
      new ExportCsvFileUseCase({
        generate: csvUseCase,
        saver: new ElectronFileSaver(),
        queue,
        clock,
        logger: silenceLogger,
      }),
    ),
  );
  const jsonUseCase = new ExportJsonUseCase({
    source: jsonSource,
    prefs: { getPrefs: () => Promise.resolve(undefined) },
    scales: { listActiveScales: () => Promise.resolve([]) },
    clock,
    appVersion: '0.0.0-test',
    logger: silenceLogger,
  });
  registry.register(
    'report/export-json',
    CHANNEL_SCHEMAS['report/export-json'],
    createExportJsonHandler(
      new ExportJsonFileUseCase({
        generate: jsonUseCase,
        saver: new ElectronFileSaver(),
        queue,
        clock,
        logger: silenceLogger,
      }),
    ),
  );

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC1: dispatch export-csv → конверт ok {path}; файл на диске == сборке use case 063 (байты)', async () => {
    const target = join(dir, 'health-log-export-20260925-1600.csv');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });

    const envelope = await registry.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: PROFILE },
    });

    expect(envelope).toMatchObject({ v: 1, ok: true, data: { path: target } });
    expect(existsSync(target)).toBe(true);
    // Содержимое файла — РОВНО csv-строка use case (§19 хендлеров: «файл создан с
    // содержимым use case»; golden-заметка с кавычками — прецедент 063).
    const expected = unsafeUnwrap(await csvUseCase.execute(PROFILE));
    expect(readFileSync(target, 'utf8')).toBe(expected.csv);
    // Диалог получил имя по умолчанию §13 и фильтр CSV (§17).
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'health-log-export-20260925-1600.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      }),
    );
  });

  it('AC2: отмена диалога → конверт ok {canceled: true}; файл не создан', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: true });

    const envelope = await registry.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: PROFILE },
    });

    expect(envelope).toMatchObject({ v: 1, ok: true, data: { canceled: true } });
  });

  it('AC4: ошибка записи → конверт ok:false EXPORT/FAILED; очередь живая — следующая операция успешна', async () => {
    // Запись в несуществующий каталог: диалог ОС «выбран», диск отказал.
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: join(dir, 'no-such-dir', 'x.csv'),
    });

    const failed = await registry.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: PROFILE },
    });
    expect(failed).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'EXPORT/FAILED', messageKey: 'errors.EXPORT_FAILED' },
    });

    // Очередь живая (§20): следующий вызов с рабочим диалогом пишет файл.
    const target = join(dir, 'after-failure.csv');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    const recovered = await registry.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: PROFILE },
    });
    expect(recovered).toMatchObject({ v: 1, ok: true, data: { path: target } });
    expect(existsSync(target)).toBe(true);
  });

  it('валидация схемы: пустой profileId → VALIDATION/FAILED, диалог не открывался', async () => {
    const callsBefore = showSaveDialog.mock.calls.length;
    const envelope = await registry.dispatch({
      channel: 'report/export-csv',
      payload: { profileId: '' },
    });

    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
    expect(showSaveDialog.mock.calls.length).toBe(callsBefore);
  });

  it('JSON-канал: файл создан, содержимое — валидный JSON-слепок (мастер-формат 064)', async () => {
    const target = join(dir, 'health-log-export-20260925-1600.json');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });

    const envelope = await registry.dispatch({
      channel: 'report/export-json',
      payload: { profileId: PROFILE },
    });

    expect(envelope).toMatchObject({ v: 1, ok: true, data: { path: target } });
    const snapshot = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ formatVersion: 1, counts: { measurements: 0 } });
    expect(showSaveDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ name: 'JSON', extensions: ['json'] }] }),
    );
  });
});
