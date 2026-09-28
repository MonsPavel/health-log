/**
 * TASK-067 §5/§9/§13: задача пула `pdf.render` (TASK-066) — payload → PDF-байты.
 *
 * ГРАНИЦЫ ЗАДАЧИ (§7): бизнес-логики нет — только сортировка строк asc (§5:
 «всегда asc — решение»), guard payload (§14: воркер получает данные из канала —
 fail-fast на повреждённой форме) и рендер шаблона. Готовые числа приходят из
 read models (052/056) в payload'е (их собирает TASK-068 на main-стороне).
 *
 * ШРИФТЫ (§9): регистрируются ОДИН раз на воркер (ensureReportFonts — флаг
 модуля воркера; воркеры пула — отдельные процессы-потоки с собственным
 реестром шрифтов react-pdf).
 *
 * МЕТРИКИ (§18): воркер не логирует — возвращает {pages, records, durationMs};
 логирует main-сторона (TASK-068). Детерминизм (§19): creationDate документа —
 из payload'а (report-document.ts), поэтому одинаковый вход → одинаковые байты.
 */
import { performance } from 'node:perf_hooks';

import { renderToBuffer } from '@react-pdf/renderer';

import { limitLastRows } from '../../domain/report-format.ts';
import type {
  PdfRenderPayload,
  PdfRenderResult,
  ReportRow,
} from '../../domain/report-spec.ts';
import type { TaskContext, TaskHandler } from '../../../shared/workerpool/protocol.js';
import { createReportDocument, ensureReportFonts } from './report-document.ts';

/** Имя задачи пула (§5). */
export const PDF_RENDER_TASK = 'pdf.render';

/** Регистратор задач — форма api из registerTasks (worker.ts TASK-066). */
export interface PdfTasksRegistrar {
  registerTask(name: string, handler: TaskHandler): void;
}

/**
 * Guard payload (§14): сужение unknown до PdfRenderPayload без any (дисциплина
 * репозитория); повреждённая форма → TypeError с именем задачи — отказ ТОЛЬКО
 * этой job (TASK-066 §13), воркер живёт. Проверяются поля, которые читают
 * шаблон и метрики; глубже — доверие собственному main-коду (тот же процесс
 * пользователя, §14 TASK-066).
 */
function parsePayload(payload: unknown): PdfRenderPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new TypeError(`${PDF_RENDER_TASK}: payload должен быть объектом`);
  }
  const shape = payload as Record<string, unknown>;
  const spec = shape['spec'] as PdfRenderPayload['spec'] | undefined;
  const data = shape['data'] as PdfRenderPayload['data'] | undefined;
  if (
    spec === undefined ||
    data === undefined ||
    !isFiniteNumber(spec.period?.fromUtcMs) ||
    !isFiniteNumber(spec.period?.toUtcMs) ||
    typeof spec.includeAiSection !== 'boolean' ||
    !isFiniteNumber(data.generatedAtUtcMs) ||
    !isFiniteNumber(data.periodTzOffsetMin) ||
    typeof data.appVersion !== 'string' ||
    !Array.isArray(data.rows) ||
    !data.rows.every(isReportRow) ||
    !isFiniteNumber(data.averages?.period?.count) ||
    !isFiniteNumber(data.averages?.period?.sysAvg) ||
    !isFiniteNumber(data.averages?.period?.diaAvg) ||
    !isFiniteNumber(data.regularity?.daysWithMeasurements) ||
    !isFiniteNumber(data.regularity?.totalDays) ||
    !isFiniteNumber(data.regularity?.longestStreakDays)
  ) {
    throw new TypeError(`${PDF_RENDER_TASK}: payload не соответствует PdfRenderPayload`);
  }
  return payload as PdfRenderPayload;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Строка таблицы: обязательные числа + опциональные пульс/рука/примечание. */
function isReportRow(row: unknown): row is ReportRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const shape = row as Record<string, unknown>;
  return (
    isFiniteNumber(shape['utcMs']) &&
    isFiniteNumber(shape['tzOffsetMin']) &&
    isFiniteNumber(shape['sys']) &&
    isFiniteNumber(shape['dia']) &&
    (shape['pulse'] === undefined || isFiniteNumber(shape['pulse'])) &&
    (shape['arm'] === undefined || shape['arm'] === 'left' || shape['arm'] === 'right') &&
    (shape['note'] === undefined || typeof shape['note'] === 'string')
  );
}

/**
 * Число страниц PDF: словари страниц pdfkit пишет без сжатия — счёт `/Type /Page`
 * без хвостовой 's' (отличаем от /Pages дерева). Для лога §18 и проверок §20.
 */
export function countPdfPages(pdf: Uint8Array): number {
  const latin = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString('latin1');
  return (latin.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

/**
 * Обработчик `pdf.render` (§5): сортировка asc → рендер → байты + метрики.
 * Отмена (кооперативная, TASK-066) задачей не поддерживается — сигнал ей не
 * передаётся (документировано §5 TASK-066; рендер конечен).
 */
export const renderPdfTask = async (
  payload: unknown,
  _context: TaskContext,
): Promise<PdfRenderResult> => {
  const startedAtMs = performance.now();
  const report = parsePayload(payload);
  ensureReportFonts();

  // §5: сортировка ВСЕГДА asc по utcMs (Array#sort стабилен — равные utc
  // сохраняют порядок входа; read model 056 сортирует utc+id на своей стороне).
  const rows = [...report.data.rows].sort((a, b) => a.utcMs - b.utcMs);
  const buffer = await renderToBuffer(
    createReportDocument({ spec: report.spec, data: { ...report.data, rows } }),
  );
  const pdf = new Uint8Array(buffer);

  return {
    pdf,
    pages: countPdfPages(pdf),
    records: limitLastRows(rows).rows.length,
    durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
  };
};

/** Регистрация задачи в реестре воркера (§9: pdf-task регистрируется в пуле). */
export function registerPdfTask(api: PdfTasksRegistrar): void {
  api.registerTask(PDF_RENDER_TASK, renderPdfTask);
}
