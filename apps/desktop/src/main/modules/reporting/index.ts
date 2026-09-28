/**
 * Публичный API модуля reporting (арх. 03 §4: чужой модуль импортируется ТОЛЬКО
 * через этот index — правило module-public-api TASK-005). Первый потребитель —
 * контейнер (дефолт tasksModule пула, TASK-067 §9); следующий — use case
 * BuildPdfReport + предпросмотр (TASK-068).
 *
 * Намеренно БЕЗ тяжёлых импортов: цепочка react-pdf (report-document/pdf-task)
 * живёт в воркере пула и из main-графа не импортируется (§7) — наружу уходят
 * только wire-типы payload'а (structured clone) и URL модуля задач.
 */
export {
  PDF_TASKS_MODULE_URL,
} from './adapters/pdf/pdf-tasks-url.js';
export { PDF_RENDER_TASK } from './adapters/pdf/pdf-task.js';
export type {
  PdfRenderPayload,
  PdfRenderResult,
  PdfTaskMap,
  ReportAiText,
  ReportAverages,
  ReportArm,
  ReportData,
  ReportPartAverages,
  ReportPeriod,
  ReportRegularity,
  ReportRow,
  ReportSpec,
} from './domain/report-spec.js';
export {
  TABLE_ROW_LIMIT,
  TABLE_ROWS_PER_PAGE,
  formatBp,
  formatDateTime,
  formatInt,
  formatLongDate,
  formatWallDate,
  formatWallTime,
  limitLastRows,
  paginateRows,
} from './domain/report-format.js';
