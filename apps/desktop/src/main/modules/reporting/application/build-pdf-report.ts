/**
 * TASK-068 §5/§7/§9: BuildPdfReportUseCase — оркестрация UC-05 «отчёт врачу»:
 * выбор периода (renderer) → валидация непустости → сборка payload из read models
 * → рендер в пуле воркеров → сохранение через ОБЩУЮ очередь файловых операций →
 * save-диалог → файл.
 *
 * ГРАНИЦЫ СЛОЁВ (§5 РЕШЕНИЕ, §4): очередь (TASK-065) сериализует ТОЛЬКО ЗАПИСЬ —
 * рендер идёт в worker pool (TASK-066) ПАРАЛЛЕЛЬНО, в очередь ставится одна запись
 * файла. Сборка payload — на main-стороне из read models (§7: шаблон 067 ничего
 * не считает); таблице нужны СЫРЫЕ точки — read model 056 отдаёт daily-агрегацию
 * при period>порога, поэтому точки запрашиваются НАПРЯМУЮ портом (§5, комментарий
 * ниже); все точки периода уходят в payload — лимит «последние 2000» и приписка
 * «последние 2000 из N» применяет воркер (limitLastRows 067 §9 — приписке нужен
 * ПОЛНЫЙ count).
 *
 * aiText (§5 РЕШЕНИЕ): параметр ВЫЗЫВАЮЩЕГО — renderer передаёт выбранное резюме
 * (ui ИИ-экрана/контекст-меню, P5); use case агностичен к ИИ-хранилищу. При
 * includeAiSection=false aiText в spec НЕ попадает (§13 067: защита от случайного
 * включения ИИ-текста в отчёт врачу — дубль защиты на main-стороне).
 *
 * ОШИБКИ (§7, значением Result — исключения не пересекают слои):
 *  - REPORT/EMPTY_PERIOD — count=0 (§9: быстрый count-запрос до сборки payload);
 *  - REPORT/RENDER_FAILED — отказ воркера ИЛИ сбой сборки payload (cause — в лог
 *    с meta.stage: 'points'|'stats'|'render', наружу только код/ключ §14);
 *  - EXPORT/FAILED — сбой записи файла (реюз кода файловых операций 065: один
 *    текст тоста errors.EXPORT_FAILED для всех сценариев сохранения, §10).
 *
 * ОТМЕНА (§9): пользователь отменил save-диалог → ok {canceled: true} — рендер
 * «зря» приемлем, debug-лог; лога успеха нет (прецедент 065 §18).
 *
 * ТЕЛЕМЕТРИЯ (§18): info `report/pdf` {period, pages, durationMs, ai} — period —
 * границы utcMs (не PHI), значения измерений в лог не идут.
 *
 * ПОРТЫ (application reporting не импортирует чужие модули — depcruise
 * application-ports, прецедент ExportCsvSource): точки — боевой ReportPointsAdapter
 * (над публичным API measurement), статистика — боевой ReportStatsAdapter (над
 * публичным API analytics + read model 052), пул — узкий PdfRenderRunner (структурно
 * удовлетворяется WorkerPool контейнера), saver — общий ExportFileSaver (065).
 */
import { performance } from 'node:perf_hooks';

import { AppError, err, ok, type Clock, type Result } from '@hl/kernel';

import {
  EXPORT_FAILED_MESSAGE_KEY,
  REPORT_EMPTY_PERIOD_MESSAGE_KEY,
  REPORT_RENDER_FAILED_MESSAGE_KEY,
} from '../domain/constants.js';
import type { ExportFileResult, ExportFileSaver } from './ports/export-file-saver.js';
import type {
  PdfRenderPayload,
  PdfRenderResult,
  ReportAiText,
  ReportData,
  ReportPeriod,
  ReportRow,
  ReportSpec,
} from './report-spec.js';
import { buildExportDefaultName, type ExportFileLogger, type FileOpRunner } from './export-file.js';

/** Миллисекунды суток/минуты — настенная арифметика (прецедент lib/period). */
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** Запрос отчёта (§7): профиль + период в готовых границах + опция ИИ-раздела. */
export interface ReportRequest {
  /** Профиль-владелец журнала (принудительный скоуп, арх. 08 §3). */
  readonly profileId: string;
  /** Границы периода по takenAt.utcMs, обе включительно (ReportPeriod 067). */
  readonly period: ReportPeriod;
  /** Явное включение ИИ-раздела (по умолчанию выключен — §3). */
  readonly includeAiSection: boolean;
  /** Текст ИИ-раздела — параметр вызывающего (§5 РЕШЕНИЕ); см. шапку §13. */
  readonly aiText?: ReportAiText;
}

/** Запрос выборки точек/статистики: профиль + включительные границы (§5). */
export interface ReportQuery {
  readonly profileId: string;
  readonly fromUtcMs: number;
  readonly toUtcMs: number;
}

/**
 * Порт чтения СЫРЫХ точек периода для таблицы (§5): mirror listByPeriod
 * репозитория (TASK-021) в форме строк отчёта. Боевой адаптер — reporting/adapters
 * (ReportPointsAdapter: только adapters вправе импортировать measurement).
 */
export interface ReportPointsSource {
  /** Быстрый count периода (§9: валидация непустости до сборки payload). */
  countByPeriod(query: ReportQuery): Promise<number>;
  /** Сырые точки периода (таблице нужен raw — не daily-агрегация 056, §5). */
  listByPeriod(query: ReportQuery): Promise<ReportRow[]>;
}

/**
 * Порт статистики периода (§5 «stats (054)»): снапшот read model 052 в форме
 * payload'а (ReportAverages/ReportRegularity). Боевой адаптер — ReportStatsAdapter
 * (над MeasurementPointsPort + buildPeriodStatistics, публичный API analytics).
 */
export interface ReportStatsSource {
  getStatistics(query: ReportQuery): Promise<{
    readonly count: number;
    readonly sysAvg: number;
    readonly diaAvg: number;
    readonly pulseAvg?: number;
    readonly morning?: {
      readonly count: number;
      readonly sysAvg: number;
      readonly diaAvg: number;
      readonly pulseAvg?: number;
    };
    readonly evening?: {
      readonly count: number;
      readonly sysAvg: number;
      readonly diaAvg: number;
      readonly pulseAvg?: number;
    };
    readonly daysWithMeasurements: number;
    readonly longestStreakDays: number;
  }>;
}

/**
 * Порт рендера в пуле (§5 `pool.run('pdf.render')`): узкая типизация карты задач
 * 067 (PdfTaskMap). Боевой WorkerPool контейнера структурно удовлетворяется через
 * адаптер в composition root (карта пула шире — run возвращает unknown).
 */
export interface PdfRenderRunner {
  run(name: 'pdf.render', payload: PdfRenderPayload): Promise<PdfRenderResult>;
}

/** Зависимости use case (§7): подстановочные в тестах (§19). */
export interface BuildPdfReportDeps {
  readonly points: ReportPointsSource;
  readonly stats: ReportStatsSource;
  readonly pool: PdfRenderRunner;
  /** Порт сохранения (диалог + запись) — общий с экспортом 065 (боевой ElectronFileSaver). */
  readonly saver: ExportFileSaver;
  /** ОБЩАЯ очередь файловых операций (§4/§9: сериализует только ЗАПИСЬ). */
  readonly queue: FileOpRunner;
  /** Порт времени: generatedAt (титул/метаданные) и имя файла по умолчанию. */
  readonly clock: Clock;
  /** Версия приложения для титула (§5; bootstrap передаёт app.getVersion()). */
  readonly appVersion: string;
  readonly logger: ExportFileLogger;
}

/** Значение успешного выполнения (§5 {pages, durationMs} + исход сохранения для канала). */
export interface BuildPdfReportValue {
  /** Число страниц PDF (метрика воркера, §18/§20). */
  readonly pages: number;
  /** Длительность сценария (сборка+рендер+запись), мс. */
  readonly durationMs: number;
  /** Исход сохранения: {path} | {canceled: true} (§7: отмена — не ошибка). */
  readonly file: ExportFileResult;
}

/**
 * Настенные дни периода «M» (§5 «N дней из M»): число дней, покрытых периодом
 * в зоне periodTzOffsetMin (день = floor((utcMs + offset·мин)/сутки)). Чистая
 * функция — юнит §19; непустой период даёт ≥1 (EMPTY_PERIOD отсечён раньше).
 */
export function totalDaysOf(period: ReportPeriod, tzOffsetMin: number): number {
  const firstDay = Math.floor((period.fromUtcMs + tzOffsetMin * MS_PER_MINUTE) / MS_PER_DAY);
  const lastDay = Math.floor((period.toUtcMs + tzOffsetMin * MS_PER_MINUTE) / MS_PER_DAY);
  return lastDay - firstDay + 1;
}

/** Use case UC-05 (§5): execute(request) → Result<{pages, durationMs, file}>. */
export class BuildPdfReportUseCase {
  constructor(private readonly deps: BuildPdfReportDeps) {}

  /** Выполняет сценарий (§5/§9); ошибки — значением Result, отмена — ok-ветка. */
  async execute(request: ReportRequest): Promise<Result<BuildPdfReportValue, AppError>> {
    const startedAtMs = performance.now();

    // Скоуп (§14): пустой profileId — программная ошибка (паритет порта TASK-021).
    if (typeof request.profileId !== 'string' || request.profileId.length === 0) {
      throw new TypeError('BuildPdfReportUseCase: profileId обязателен (непустая строка)');
    }

    const query: ReportQuery = {
      profileId: request.profileId,
      fromUtcMs: request.period.fromUtcMs,
      toUtcMs: request.period.toUtcMs,
    };

    // 1. Валидация непустости (§9): быстрый count-запрос ДО сборки payload.
    let count: number;
    try {
      count = await this.deps.points.countByPeriod(query);
    } catch (cause) {
      return this.renderFailed(cause, startedAtMs, 'count');
    }
    if (count === 0) {
      // §7/§9: пустой период не формируется — err RENDER не нужен, код свой.
      return err(AppError.of('REPORT/EMPTY_PERIOD', REPORT_EMPTY_PERIOD_MESSAGE_KEY));
    }

    // 2. Сборка payload (§5): сырые точки напрямую портом (§5 — таблице нужен raw;
    //    все точки периода — лимит «последние 2000 из N» применяет воркер 067)
    //    и статистика read model 052 (§5 «stats (054)»).
    let rows: ReportRow[];
    let snapshot: Awaited<ReturnType<ReportStatsSource['getStatistics']>>;
    try {
      rows = await this.deps.points.listByPeriod(query);
    } catch (cause) {
      return this.renderFailed(cause, startedAtMs, 'points');
    }
    try {
      snapshot = await this.deps.stats.getStatistics(query);
    } catch (cause) {
      return this.renderFailed(cause, startedAtMs, 'stats');
    }

    // 3. ReportSpec (067): aiText попадает ТОЛЬКО при явном includeAiSection (§13).
    const spec: ReportSpec = {
      period: request.period,
      includeAiSection: request.includeAiSection,
      ...(request.includeAiSection && request.aiText !== undefined
        ? { aiText: request.aiText }
        : {}),
    };

    // 4. ReportData (067): готовые числа read models; настенные компоненты титула —
    //    от Clock (генерация «сейчас» в зоне устройства). Точки → asc (детерминизм
    //    payload: порядок порта — desc репозитория, шаблон сортирует ещё раз —
    //    стабильно, но payload каноничен asc).
    const generatedAtUtcMs = this.deps.clock.nowMs();
    const periodTzOffsetMin = this.deps.clock.tzOffsetMin();
    const data: ReportData = {
      appVersion: this.deps.appVersion,
      generatedAtUtcMs,
      periodTzOffsetMin,
      rows: [...rows].sort((a, b) => a.utcMs - b.utcMs),
      averages: {
        period: {
          count: snapshot.count,
          sysAvg: snapshot.sysAvg,
          diaAvg: snapshot.diaAvg,
          ...(snapshot.pulseAvg !== undefined ? { pulseAvg: snapshot.pulseAvg } : {}),
        },
        ...(snapshot.morning !== undefined ? { morning: snapshot.morning } : {}),
        ...(snapshot.evening !== undefined ? { evening: snapshot.evening } : {}),
      },
      regularity: {
        daysWithMeasurements: snapshot.daysWithMeasurements,
        totalDays: totalDaysOf(request.period, periodTzOffsetMin),
        longestStreakDays: snapshot.longestStreakDays,
      },
    };

    // 5. Рендер в пуле (§4: НЕ в очереди — воркеры параллельны записям).
    let rendered: PdfRenderResult;
    try {
      rendered = await this.deps.pool.run('pdf.render', { spec, data });
    } catch (cause) {
      return this.renderFailed(cause, startedAtMs, 'render');
    }

    // 6. Сохранение (§4/§9): очередь сериализует ТОЛЬКО ЗАПИСЬ (одна операция
    //    с экспортами 065 и копиями БД 070). Имя по умолчанию — общий механизм 065.
    const defaultName = buildExportDefaultName(this.deps.clock, 'pdf');
    let saved: ExportFileResult;
    try {
      saved = await this.deps.queue.run(() => this.deps.saver.savePdf(defaultName, rendered.pdf));
    } catch (cause) {
      const error = AppError.of('EXPORT/FAILED', EXPORT_FAILED_MESSAGE_KEY, undefined, cause);
      this.deps.logger.error('report/pdf: не удалось записать файл', {
        code: error.code,
        pages: rendered.pages,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return err(error);
    }

    // 7. Исход (§7/§18): отмена — debug-лог без лога успеха (рендер зря — §9);
    //    успех — info `report/pdf` {period, pages, durationMs, ai} (basename и
    //    полный путь в лог не идут — §14, прецедент 065).
    if ('canceled' in saved) {
      this.deps.logger.debug('report/pdf: сохранение отменено пользователем', {
        pages: rendered.pages,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return ok({ pages: rendered.pages, durationMs: this.elapsedMs(startedAtMs), file: saved });
    }
    this.deps.logger.info('report/pdf', {
      period: `${request.period.fromUtcMs}..${request.period.toUtcMs}`,
      pages: rendered.pages,
      durationMs: this.elapsedMs(startedAtMs),
      ai: spec.includeAiSection,
    });
    return ok({ pages: rendered.pages, durationMs: this.elapsedMs(startedAtMs), file: saved });
  }

  /** Единая доставка отказа рендера (§7): cause — в main-лог с этапом, наружу код. */
  private renderFailed(
    cause: unknown,
    startedAtMs: number,
    stage: 'count' | 'points' | 'stats' | 'render',
  ): Result<BuildPdfReportValue, AppError> {
    const error = AppError.of('REPORT/RENDER_FAILED', REPORT_RENDER_FAILED_MESSAGE_KEY, undefined, cause);
    this.deps.logger.error('report/pdf: не удалось сформировать отчёт', {
      code: error.code,
      stage,
      durationMs: this.elapsedMs(startedAtMs),
      cause,
    });
    return err(error);
  }

  private elapsedMs(startedAtMs: number): number {
    return Math.round(performance.now() - startedAtMs);
  }
}
