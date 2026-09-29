// TASK-068 §5/§7/§9/§13/§18/§19: юниты BuildPdfReportUseCase — оркестрация UC-05
// (моки pool/saver, §19). Матрица:
//  - happy path (порядок render→save): count → payload (точки+stats) → pool.run →
//    ОЧЕРЕДЬ только на запись (§4) → saver.savePdf → ok {pages, durationMs, file};
//  - EMPTY_PERIOD: count=0 → err REPORT/EMPTY_PERIOD до сборки payload (§9);
//  - aiText: includeAiSection=false — aiText в spec НЕ попадает (§13 067);
//    includeAiSection=true — попадает (§5: параметр вызывающего);
//  - canceled: {canceled: true} — ok-ветка без лога успеха, debug-лог (§9);
//  - ошибка рендера (мок пула) → REPORT/RENDER_FAILED, saver не зовётся (§7);
//  - сбой сборки payload (чтение точек/stats) → REPORT/RENDER_FAILED (stage);
//  - сбой записи → EXPORT/FAILED (реюз кода файловых операций, §10);
//  - пустой profileId → TypeError (паритет порта, §14);
//  - телеметрия §18: `report/pdf` {period, pages, durationMs, ai} — без PHI;
//  - totalDaysOf: чистая функция настенных дней периода (§5 «N из M»).
import { describe, expect, it, vi, type Mock } from 'vitest';

import { FixedClock } from '@hl/kernel';

import { BuildPdfReportUseCase, totalDaysOf } from './build-pdf-report.js';
import type {
  BuildPdfReportDeps,
  PdfRenderRunner,
  ReportPointsSource,
  ReportStatsSource,
} from './build-pdf-report.js';
import type { PdfRenderPayload, PdfRenderResult } from './report-spec.js';
import type { ExportFileResult, ExportFileSaver } from './ports/export-file-saver.js';
import type { ExportFileLogger } from './export-file.js';

const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z (настенное +03:00 → 19:00)
const TZ = 180;
const PROFILE = 'seed-profile-0001';
const PERIOD = { fromUtcMs: 1_758_000_000_000, toUtcMs: 1_758_816_000_000 };

const RENDER_RESULT: PdfRenderResult = {
  pdf: new Uint8Array([1, 2, 3, 4]),
  pages: 2,
  records: 3,
  durationMs: 40,
};

/** Точки от порта — в порядке репозитория (takenAt desc): use case обязан
 *  отправить в payload asc (детерминизм, §5 сортировка шаблона). */
const DESC_ROWS = [
  { utcMs: 1_758_700_000_000, tzOffsetMin: TZ, sys: 122, dia: 81, pulse: 66 },
  { utcMs: 1_758_200_000_000, tzOffsetMin: TZ, sys: 118, dia: 76 },
];

const STATS = {
  count: 2,
  sysAvg: 120,
  diaAvg: 78.5,
  pulseAvg: 65,
  morning: { count: 1, sysAvg: 118, diaAvg: 76, pulseAvg: 64 },
  daysWithMeasurements: 2,
  longestStreakDays: 2,
};

/** Шпионы зависимостей (типизированные Mock через владельца — прецедент 065). */
interface DepsSpies {
  readonly countByPeriod: Mock<ReportPointsSource['countByPeriod']>;
  readonly listByPeriod: Mock<ReportPointsSource['listByPeriod']>;
  readonly getStatistics: Mock<ReportStatsSource['getStatistics']>;
  readonly render: Mock<PdfRenderRunner['run']>;
  readonly savePdf: Mock<ExportFileSaver['savePdf']>;
  readonly logger: {
    readonly debug: Mock<ExportFileLogger['debug']>;
    readonly info: Mock<ExportFileLogger['info']>;
    readonly error: Mock<ExportFileLogger['error']>;
  };
}

/** Собранные зависимости с журналом вызовов (§19: подстановочные порты). */
function makeDeps(
  overrides: Partial<BuildPdfReportDeps> = {},
): { readonly deps: BuildPdfReportDeps; readonly calls: string[] } & DepsSpies {
  const calls: string[] = [];
  const countByPeriod: DepsSpies['countByPeriod'] = vi.fn(() => {
    calls.push('count');
    return Promise.resolve(2);
  });
  const listByPeriod: DepsSpies['listByPeriod'] = vi.fn(() => {
    calls.push('points');
    return Promise.resolve(DESC_ROWS);
  });
  const getStatistics: DepsSpies['getStatistics'] = vi.fn(() => {
    calls.push('stats');
    return Promise.resolve(STATS);
  });
  const render: DepsSpies['render'] = vi.fn((_name: 'pdf.render', payload: PdfRenderPayload) => {
    calls.push('render');
    expect(payload.spec.period).toEqual(PERIOD);
    return Promise.resolve(RENDER_RESULT);
  });
  const savePdf: DepsSpies['savePdf'] = vi.fn(() => {
    calls.push('save');
    return Promise.resolve({ path: 'C:\\out\\health-log-export-20250925-1900.pdf' });
  });
  const logger: DepsSpies['logger'] = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

  const deps: BuildPdfReportDeps = {
    points: { countByPeriod, listByPeriod } satisfies ReportPointsSource,
    stats: { getStatistics } satisfies ReportStatsSource,
    pool: { run: render } satisfies PdfRenderRunner,
    saver: {
      saveCsv: vi.fn(() => Promise.reject(new Error('saveCsv не должен вызываться'))),
      saveJson: vi.fn(() => Promise.reject(new Error('saveJson не должен вызываться'))),
      savePdf,
    },
    // Очередь-прозрачка: прогон операции сразу + журнал (порядок проверяют тесты);
    // дженерик T — контракт FileOpRunner, Mock-обёртка не нужна (журнал — calls).
    queue: {
      run: <T>(operation: () => Promise<T>) => {
        calls.push('queue');
        return operation();
      },
    },
    clock: new FixedClock(NOW_MS, TZ),
    appVersion: '1.2.3',
    logger,
    ...overrides,
  };
  return { deps, calls, countByPeriod, listByPeriod, getStatistics, render, savePdf, logger };
}

const REQUEST = { profileId: PROFILE, period: PERIOD, includeAiSection: false } as const;

describe('BuildPdfReportUseCase — happy path (§5/§9, порядок render→save)', () => {
  it('count → payload → pool.run → очередь записи → savePdf → ok {pages, durationMs, file}', async () => {
    const { deps, calls, savePdf } = makeDeps();
    const useCase = new BuildPdfReportUseCase(deps);

    const result = await useCase.execute(REQUEST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pages).toBe(2);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.value.file).toEqual({ path: 'C:\\out\\health-log-export-20250925-1900.pdf' });
    }
    // Порядок §9: count → точки+stats → рендер → очередь → запись.
    expect(calls).toEqual(['count', 'points', 'stats', 'render', 'queue', 'save']);
    // Имя файла по умолчанию — тот же механизм, что у экспорта (§13 065, ext pdf).
    expect(savePdf).toHaveBeenCalledWith('health-log-export-20250925-1900.pdf', RENDER_RESULT.pdf);
  });

  it('payload: spec {period, includeAiSection}, data {appVersion, generatedAt, tz, rows asc, averages, regularity{totalDays}}', async () => {
    const { deps, render } = makeDeps();
    const useCase = new BuildPdfReportUseCase(deps);
    await useCase.execute(REQUEST);

    const payload = render.mock.calls[0]?.[1] as PdfRenderPayload;
    expect(payload.spec).toEqual({
      period: PERIOD,
      includeAiSection: false,
      // aiText при includeAiSection=false НЕ попадает в spec (§13).
    });
    expect('aiText' in payload.spec).toBe(false);
    expect(payload.data.appVersion).toBe('1.2.3');
    expect(payload.data.generatedAtUtcMs).toBe(NOW_MS);
    expect(payload.data.periodTzOffsetMin).toBe(TZ);
    // Точки порта (desc) → payload asc.
    expect(payload.data.rows.map((row) => row.utcMs)).toEqual([
      1_758_200_000_000, 1_758_700_000_000,
    ]);
    expect(payload.data.averages.period).toEqual({
      count: 2,
      sysAvg: 120,
      diaAvg: 78.5,
      pulseAvg: 65,
    });
    expect(payload.data.averages.morning).toEqual({
      count: 1,
      sysAvg: 118,
      diaAvg: 76,
      pulseAvg: 64,
    });
    expect('evening' in payload.data.averages).toBe(false);
    // totalDays — настенные дни периода (чистая функция, §5 «N из M»).
    expect(payload.data.regularity).toEqual({
      daysWithMeasurements: 2,
      totalDays: 10,
      longestStreakDays: 2,
    });
  });

  it('includeAiSection=true + aiText → spec несёт aiText (§5: параметр вызывающего)', async () => {
    const { deps, render } = makeDeps();
    const useCase = new BuildPdfReportUseCase(deps);
    await useCase.execute({
      ...REQUEST,
      includeAiSection: true,
      aiText: { contentMd: 'Резюме', generatedAt: NOW_MS - 1000, modelId: 'test-model' },
    });

    const payload = render.mock.calls[0]?.[1] as PdfRenderPayload;
    expect(payload.spec.includeAiSection).toBe(true);
    expect(payload.spec.aiText).toEqual({
      contentMd: 'Резюме',
      generatedAt: NOW_MS - 1000,
      modelId: 'test-model',
    });
  });

  it('телеметрия §18: info `report/pdf` {period, pages, durationMs, ai} — без значений измерений', async () => {
    const { deps, logger } = makeDeps();
    const useCase = new BuildPdfReportUseCase(deps);
    await useCase.execute(REQUEST);

    expect(logger.info).toHaveBeenCalledWith(
      'report/pdf',
      expect.objectContaining({ pages: 2, ai: false }),
    );
    const meta = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(String(meta['period'])).toContain(String(PERIOD.fromUtcMs));
  });
});

describe('BuildPdfReportUseCase — EMPTY_PERIOD (§7/§9, AC UC-05 A2)', () => {
  it('count=0 → err REPORT/EMPTY_PERIOD; payload/render/save не вызываются', async () => {
    const countByPeriod = vi.fn(() => Promise.resolve(0));
    const listByPeriod = vi.fn(() => Promise.reject(new Error('не должен зваться')));
    const { deps, logger, getStatistics, render, savePdf } = makeDeps({
      points: { countByPeriod, listByPeriod },
    });
    const useCase = new BuildPdfReportUseCase(deps);

    const result = await useCase.execute(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REPORT/EMPTY_PERIOD');
      expect(result.error.messageKey).toBe('errors.REPORT_EMPTY_PERIOD');
    }
    expect(countByPeriod).toHaveBeenCalledTimes(1);
    expect(listByPeriod).not.toHaveBeenCalled();
    expect(getStatistics).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(savePdf).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('BuildPdfReportUseCase — отмена и ошибки (§7/§9/§10)', () => {
  it('отмена диалога {canceled: true} → ok-ветка, лога успеха нет, debug-лог (§9)', async () => {
    const { deps, logger } = makeDeps({
      saver: {
        saveCsv: vi.fn(),
        saveJson: vi.fn(),
        savePdf: vi.fn((): Promise<ExportFileResult> => Promise.resolve({ canceled: true })),
      },
    });
    const useCase = new BuildPdfReportUseCase(deps);

    const result = await useCase.execute(REQUEST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.file).toEqual({ canceled: true });
      expect(result.value.pages).toBe(2);
    }
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('ошибка пула (мок) → err REPORT/RENDER_FAILED, save не зовётся, cause в error-логе', async () => {
    const cause = new Error('worker crashed');
    const { deps, calls, savePdf, logger } = makeDeps({
      pool: { run: vi.fn(() => Promise.reject(cause)) },
    });
    const useCase = new BuildPdfReportUseCase(deps);

    const result = await useCase.execute(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REPORT/RENDER_FAILED');
      expect(result.error.messageKey).toBe('errors.REPORT_RENDER_FAILED');
    }
    // Рендер был последним шагом: точки/stats собраны, запись не начиналась.
    expect(calls).toEqual(['count', 'points', 'stats']);
    expect(savePdf).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('report/pdf'),
      expect.objectContaining({ code: 'REPORT/RENDER_FAILED', cause }),
    );
  });

  it('сбой чтения точек (сборка payload) → err REPORT/RENDER_FAILED, render не зовётся', async () => {
    const countByPeriod = vi.fn(() => Promise.resolve(2));
    const listByPeriod = vi.fn(() => Promise.reject(new Error('storage down')));
    const { deps, getStatistics, render } = makeDeps({
      points: { countByPeriod, listByPeriod },
    });
    const useCase = new BuildPdfReportUseCase(deps);

    const result = await useCase.execute(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('REPORT/RENDER_FAILED');
    }
    expect(countByPeriod).toHaveBeenCalledTimes(1);
    expect(listByPeriod).toHaveBeenCalledTimes(1);
    expect(getStatistics).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('сбой записи файла → err EXPORT/FAILED (реюз кода файловых операций, §10)', async () => {
    const { deps } = makeDeps({
      saver: {
        saveCsv: vi.fn(),
        saveJson: vi.fn(),
        savePdf: vi.fn(() => Promise.reject(new Error('disk full'))),
      },
    });
    const useCase = new BuildPdfReportUseCase(deps);

    const result = await useCase.execute(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EXPORT/FAILED');
      expect(result.error.messageKey).toBe('errors.EXPORT_FAILED');
    }
  });

  it('пустой profileId → TypeError (паритет порта репозитория, §14)', async () => {
    const { deps } = makeDeps();
    const useCase = new BuildPdfReportUseCase(deps);
    await expect(useCase.execute({ ...REQUEST, profileId: '' })).rejects.toThrow(TypeError);
  });
});

describe('totalDaysOf — настенные дни периода (§5 «N из M»)', () => {
  it('один настенный день (утро-вечер одного дня в одной зоне) → 1', () => {
    // 2026-09-25 00:10 UTC+3 .. 2026-09-25 23:50 UTC+3 — один настенный день.
    const from = Date.UTC(2026, 8, 24, 21, 10);
    const to = Date.UTC(2026, 8, 25, 20, 50);
    expect(totalDaysOf({ fromUtcMs: from, toUtcMs: to }, TZ)).toBe(1);
  });

  it('десятидневный период фикстуры → 10 (span 816 000 000 мс ≈ 9.4 дня → 10 настенных дней)', () => {
    expect(PERIOD.toUtcMs - PERIOD.fromUtcMs).toBe(816_000_000);
    expect(totalDaysOf(PERIOD, TZ)).toBe(10);
  });
});
