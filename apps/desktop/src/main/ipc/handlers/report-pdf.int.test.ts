// TASK-068 §20-1/§20-4 (автоматический эквивалент): полный боевой путь канала
// `report/pdf` по проводам каркаса TASK-008 — прецедент report.int.test.ts (065):
// dispatch(registry) → zod → хендлер → use case BuildPdfReport (fake-порты точек/
// статистики — их боевые адаптеры поверх SQLite покрывает reporting-pdf-smoke) →
// РЕАЛЬНЫЙ WorkerPool с боевой задачей pdf.render (067) → ОБЩАЯ FileOpQueue →
// ElectronFileSaver (dialog MOCK — §19 «отмена диалога (mock)»; writeFile —
// РЕАЛЬНЫЙ, файл на диске в tmp).
//
// Автоматический эквивалент §20-1 «открывается»: файл на диске — структурно
// валидный PDF (%PDF- заголовок, %%EOF хвост, ≥2 страниц на 50 записей, >10 КБ —
// встроенный Roboto с кириллицей) — всё, что о «открывается в системном
// просмотрщике» проверяемо без GUI; просмотр файла человеком — ручная §24.
// §20-4: отмена save-диалога → конверт ok {canceled: true}, файл не создан.
// §20-5: отказ сборки (чтение точек) → ok:false REPORT/RENDER_FAILED.
// Плюс имя/фильтр диалога (§13/§17) и пустой период через канал (§20-2 AC).
//
// TDD-заметка: вся цепочка реализована в TASK-068 (коммиты 0bd9ea8/e80326f) —
// тесты GREEN с первого прогона; RED невозможен без поломки боевого кода
// (прецедент TASK-065 file-op-queue: «реализация смержена — RED невозможен»).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import { FixedClock } from '@hl/kernel';

// Шпион диалога — vi.hoisted (прецедент report.int.test.ts).
const { showSaveDialog } = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showSaveDialog } }));

import { createChannelRegistry, type ChannelRegistry } from '../register-channel.js';
import { ElectronFileSaver } from '../../platform/file-saver.js';
import { FileOpQueue } from '../../modules/data-care/application/file-op-queue.js';
import { WorkerPool } from '../../shared/workerpool/pool.js';
import { PDF_TASKS_MODULE_URL } from '../../modules/reporting/adapters/pdf/pdf-tasks-url.js';
import { BuildPdfReportUseCase } from '../../modules/reporting/application/build-pdf-report.js';
import { createBuildPdfReportHandler } from './report-pdf.js';
import type { ReportRow } from '../../modules/reporting/application/report-spec.js';

const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00Z (настенное +03:00 → 19:00)
const TZ = 180;
const PROFILE = 'seed-profile-0001';
const RECORDS = 50;
const FROM = NOW_MS - 86_400_000 * 31;
const TO = NOW_MS;

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

/** 50 сырых точек за ~30 дней (desc — порядок репозитория, use case строит asc). */
const rows = (): ReportRow[] =>
  Array.from({ length: RECORDS }, (_, i) => ({
    utcMs: FROM + Math.floor(((TO - FROM) * i) / RECORDS),
    tzOffsetMin: TZ,
    sys: 112 + (i % 38),
    dia: 71 + (i % 23),
    ...(i % 3 === 0 ? { pulse: 58 + (i % 28) } : {}),
    arm: i % 2 === 0 ? ('left' as const) : ('right' as const),
    ...(i % 10 === 0 ? { note: `заметка ${i}` } : {}),
  }));

const statsSnapshot = {
  count: RECORDS,
  sysAvg: 130,
  diaAvg: 82,
  pulseAvg: 70,
  morning: { count: 25, sysAvg: 128, diaAvg: 80, pulseAvg: 69 },
  evening: { count: 25, sysAvg: 132, diaAvg: 84, pulseAvg: 71 },
  daysWithMeasurements: 30,
  longestStreakDays: 30,
};

/** Реестр с полной боевой цепочкой report/pdf (подстановочны только точки/stats). */
function makeRegistry(points: {
  countByPeriod: () => Promise<number>;
  listByPeriod: () => Promise<ReportRow[]>;
}): { registry: ChannelRegistry; pool: WorkerPool } {
  const registry = createChannelRegistry();
  const pool = new WorkerPool({
    // entry .ts под type-stripping (прецедент container-pdf.int.test.ts);
    // tasksModule — БОЕВОЙ (задача pdf.render 067).
    entryUrl: new URL('../../shared/workerpool/worker.ts', import.meta.url),
    tasksModule: PDF_TASKS_MODULE_URL.href,
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    },
  });
  registry.register(
    'report/pdf',
    CHANNEL_SCHEMAS['report/pdf'],
    createBuildPdfReportHandler(
      new BuildPdfReportUseCase({
        points,
        stats: { getStatistics: () => Promise.resolve(statsSnapshot) },
        pool: {
          run: (name, payload) =>
            pool.run(name, payload) as Promise<{
              pdf: Uint8Array;
              pages: number;
              records: number;
              durationMs: number;
            }>,
        },
        saver: new ElectronFileSaver(),
        queue: new FileOpQueue(),
        clock: new FixedClock(NOW_MS, TZ),
        appVersion: '0.0.0-test',
        logger,
      }),
    ),
  );
  return { registry, pool };
}

describe('report/pdf: каркас → use case → пул (pdf.render) → очередь → saver (TASK-068 §20-1/§20-4/§20-5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-report-pdf-int-'));
  const pool = new WorkerPool({
    entryUrl: new URL('../../shared/workerpool/worker.ts', import.meta.url),
    tasksModule: PDF_TASKS_MODULE_URL.href,
  });

  afterAll(() => {
    void pool.terminate();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'happy path: конверт ok {path}; на диске структурно валидный PDF >10 КБ (%PDF-, %%EOF, ≥2 страниц)',
    { timeout: 60_000 },
    async () => {
      const target = join(dir, 'health-log-export-20250925-1900.pdf');
      showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
      const { registry, pool: chainPool } = makeRegistry({
        countByPeriod: () => Promise.resolve(RECORDS),
        listByPeriod: () => Promise.resolve(rows()),
      });

      const envelope = await registry.dispatch({
        channel: 'report/pdf',
        payload: {
          profileId: PROFILE,
          period: { fromUtcMs: FROM, toUtcMs: TO },
          includeAiSection: false,
        },
      });

      expect(envelope).toMatchObject({ v: 1, ok: true, data: { path: target } });
      expect(existsSync(target)).toBe(true);

      // Автоматический эквивалент §20-1 «открывается» (без GUI): структура PDF-файла —
      // заголовок и хвост документа, размер со встроенным шрифтом, число страниц.
      const bytes = readFileSync(target);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(bytes.subarray(bytes.length - 32).toString('latin1')).toContain('%%EOF');
      expect(statSync(target).size).toBeGreaterThan(10 * 1024);
      const latin = bytes.toString('latin1');
      expect((latin.match(/\/Type\s*\/Page(?![s])/g) ?? []).length).toBeGreaterThanOrEqual(2);

      // Диалог получил имя по умолчанию (механизм 065, ext pdf) и фильтр PDF (§17).
      expect(showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'health-log-export-20250925-1900.pdf',
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        }),
      );
      // Успех залогирован §18 (basename не идёт в лог — путь только в ответе).
      expect(logger.info).toHaveBeenCalledWith(
        'report/pdf',
        expect.objectContaining({ ai: false }),
      );
      const meta = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(typeof meta['pages']).toBe('number');
      void chainPool;
    },
  );

  it(
    '§20-4: отмена save-диалога → конверт ok {canceled: true}; файл не создан',
    { timeout: 60_000 },
    async () => {
      const target = join(dir, 'canceled.pdf');
      showSaveDialog.mockResolvedValueOnce({ canceled: true });
      const { registry } = makeRegistry({
        countByPeriod: () => Promise.resolve(RECORDS),
        listByPeriod: () => Promise.resolve(rows()),
      });

      const envelope = await registry.dispatch({
        channel: 'report/pdf',
        payload: {
          profileId: PROFILE,
          period: { fromUtcMs: FROM, toUtcMs: TO },
          includeAiSection: false,
        },
      });

      expect(envelope).toEqual({ v: 1, ok: true, data: { canceled: true } });
      expect(existsSync(target)).toBe(false);
      // Рендер «зря» задокументирован debug-логом (§9), лога успеха нет (§18).
      expect(logger.debug).toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    },
  );

  it('§20-2 (AC UC-05 A2) через канал: пустой период → ok:false REPORT/EMPTY_PERIOD, диалог не открывался', async () => {
    const callsBefore = showSaveDialog.mock.calls.length;
    const { registry } = makeRegistry({
      countByPeriod: () => Promise.resolve(0),
      listByPeriod: () => Promise.reject(new Error('не должен зваться')),
    });

    const envelope = await registry.dispatch({
      channel: 'report/pdf',
      payload: {
        profileId: PROFILE,
        period: { fromUtcMs: FROM, toUtcMs: TO },
        includeAiSection: false,
      },
    });

    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'REPORT/EMPTY_PERIOD' } });
    expect(showSaveDialog.mock.calls.length).toBe(callsBefore);
  });

  it('§20-5 через канал: сбой сборки payload → ok:false REPORT/RENDER_FAILED (причина — в main-логе)', async () => {
    const { registry } = makeRegistry({
      countByPeriod: () => Promise.resolve(RECORDS),
      listByPeriod: () => Promise.reject(new Error('storage down')),
    });

    const envelope = await registry.dispatch({
      channel: 'report/pdf',
      payload: {
        profileId: PROFILE,
        period: { fromUtcMs: FROM, toUtcMs: TO },
        includeAiSection: false,
      },
    });

    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'REPORT/RENDER_FAILED', messageKey: 'errors.REPORT_RENDER_FAILED' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('report/pdf'),
      expect.objectContaining({ code: 'REPORT/RENDER_FAILED', stage: 'points' }),
    );
  });
});
