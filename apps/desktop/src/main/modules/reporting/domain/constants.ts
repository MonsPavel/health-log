/**
 * TASK-063 §5/§13: единственный источник ключей ошибок модуля reporting (прецедент
 * measurement/domain/constants.ts TASK-016). Ключ — по конвенции арх. 05 §29
 * (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); сам текст в каталоге рендерера появляется с UI
 * экспорта TASK-065 (прецедент: ключи TASK-016/017 — тексты TASK-031/032).
 */
export const EXPORT_FAILED_MESSAGE_KEY = 'errors.EXPORT_FAILED';

/**
 * TASK-068 §7: ключи ошибок PDF-отчёта. EMPTY_PERIOD — пустой период не формируется
 * (§9: count=0 — быстрый count-запрос до сборки payload; UI блокирует кнопку заранее
 * по count из stats, §13); RENDER_FAILED — отказ воркера/сборки payload (cause — в
 * main-лог, наружу только код/ключ, §14). Тексты — в errors.json с UI TASK-068.
 */
export const REPORT_EMPTY_PERIOD_MESSAGE_KEY = 'errors.REPORT_EMPTY_PERIOD';
export const REPORT_RENDER_FAILED_MESSAGE_KEY = 'errors.REPORT_RENDER_FAILED';
