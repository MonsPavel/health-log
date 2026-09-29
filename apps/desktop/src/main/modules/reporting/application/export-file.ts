/**
 * TASK-065 §5/§9/§13/§18: общая механика оркестрации файлового экспорта —
 * «FileOpQueue → use case генерации (063/064) → FileSaver». Конкретные сценарии —
 * ExportCsvFileUseCase (export-csv-file.ts) и ExportJsonFileUseCase
 * (export-json-file.ts); здесь — имя файла по умолчанию, прогон через очередь и
 * телеметрия §18.
 *
 * ОЧЕРЕДЬ (§9/§13): экспорты и копии БД (TASK-070) выполняются строго по одной —
 * порт FileOpRunner (минимальная поверхность FileOpQueue data-care; инстанс один
 * в контейнере, §9). Таймаутов нет (§13: большие экспорты легитимны); сбой одной
 * операции очередь не ломает (§19 file-op-queue.test.ts) — ошибка доставляется
 * вызвавшему.
 *
 * ИМЯ ФАЙЛА (§13, фикс): `health-log-export-YYYYMMDD-HHmm.csv|json` в ЛОКАЛЬНОМ
 * времени устройства (порт Clock: nowMs + tzOffsetMin → настенные компоненты).
 * Перезапись существующего решает стандартный диалог ОС (§13) — здесь не проверяется.
 *
 * ТЕЛЕМЕТРИЯ (§18): info `export csv|json` {basename, count, durationMs} — ТОЛЬКО
 * basename (полный путь содержит имя Windows-пользователя, §14/§18); неуспех записи
 * — error с кодом; сбой генерации уже залогирован внутренним use case (не дублируется).
 */
import { performance } from 'node:perf_hooks';

import { AppError, err, ok, type Clock, type Result } from '@hl/kernel';

import { EXPORT_FAILED_MESSAGE_KEY } from '../domain/constants.js';
import type { ExportFileResult } from './ports/export-file-saver.js';

/** Порт очереди файловых операций (§9): минимальная поверхность FileOpQueue. */
export interface FileOpRunner {
  /** Ставит операцию в очередь; результат/ошибка операции — как есть (§5). */
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Минимальная поверхность логгера оркестратора (§18); HlLogger ей удовлетворяет. */
export interface ExportFileLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Результат генерации внутреннего use case (063: {csv,count}; 064: {json,count}). */
interface Generated {
  readonly content: string;
  readonly count: number;
}

/** Падение двухзначного числа нулём (компоненты имени файла, §13). */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Имя файла по умолчанию (§13/§20 AC5): health-log-export-YYYYMMDD-HHmm.<ext> в
 * локальном времени. Сдвиг на tzOffsetMin даёт настенные компоненты через UTC-геттеры
 * Date (прецедент takenAt-инварианта ядра: utcMs + offset·мин = настенное время).
 * TASK-068: ext расширен 'pdf' — тот же механизм имени для PDF-отчёта (§23 реюз).
 */
export function buildExportDefaultName(clock: Clock, ext: 'csv' | 'json' | 'pdf'): string {
  const wall = new Date(clock.nowMs() + clock.tzOffsetMin() * 60_000);
  const y = wall.getUTCFullYear();
  const mo = pad2(wall.getUTCMonth() + 1);
  const d = pad2(wall.getUTCDate());
  const h = pad2(wall.getUTCHours());
  const mi = pad2(wall.getUTCMinutes());
  return `health-log-export-${y}${mo}${d}-${h}${mi}.${ext}`;
}

/** Basename для лога §18: разделители обеих платформ (путь — результат диалога ОС). */
export function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

/** Параметры прогона экспорта через очередь (§9): генерация → запись → телеметрия. */
export interface QueuedExportParams {
  /** Метка сценария для лога §18: 'csv' | 'json'. */
  readonly kind: 'csv' | 'json';
  readonly queue: FileOpRunner;
  readonly clock: Clock;
  readonly logger: ExportFileLogger;
  /** Генерация содержимого (use case 063/064); сбой — err насквозь, saver не зовётся. */
  readonly generate: () => Promise<Result<Generated, AppError>>;
  /** Запись файла (метод порта saver под сценарий); сбой — исключение. */
  readonly save: (defaultName: string, content: string) => Promise<ExportFileResult>;
}

/**
 * Прогон одного экспорта (§5/§9): очередь → генерация → запись → {path}|{canceled}.
 * Ошибки — значением Result (err EXPORT/FAILED на сбое записи; сбой генерации
 * проходит как есть — код уже доставлен use case'ом), исключения не пересекают слои.
 */
export async function runQueuedExport(
  params: QueuedExportParams,
): Promise<Result<ExportFileResult, AppError>> {
  const startedAtMs = performance.now();

  return params.queue.run(async () => {
    // 1. Генерация (§5): use case 063/064; err — насквозь (свой §18-лог внутри).
    const generated = await params.generate();
    if (!generated.ok) {
      return err(generated.error);
    }

    // 2. Запись (§5/§10): сбой диска/прав → err EXPORT/FAILED значением (§9).
    let saved: ExportFileResult;
    try {
      saved = await params.save(
        buildExportDefaultName(params.clock, params.kind),
        generated.value.content,
      );
    } catch (cause) {
      const error = AppError.of('EXPORT/FAILED', EXPORT_FAILED_MESSAGE_KEY, undefined, cause);
      params.logger.error(`export ${params.kind}: не удалось записать файл`, {
        code: error.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return err(error);
    }

    // 3. Телеметрия §18 (успех): basename + count — полный путь наружу лога не идёт.
    if ('path' in saved) {
      params.logger.info(`export ${params.kind}`, {
        basename: basenameOf(saved.path),
        count: generated.value.count,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
    }

    return ok(saved);
  });
}
