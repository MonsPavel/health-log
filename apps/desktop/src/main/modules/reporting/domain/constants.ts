/**
 * TASK-063 §5/§13: единственный источник ключей ошибок модуля reporting (прецедент
 * measurement/domain/constants.ts TASK-016). Ключ — по конвенции арх. 05 §29
 * (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); сам текст в каталоге рендерера появляется с UI
 * экспорта TASK-065 (прецедент: ключи TASK-016/017 — тексты TASK-031/032).
 */
export const EXPORT_FAILED_MESSAGE_KEY = 'errors.EXPORT_FAILED';
