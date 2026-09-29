/**
 * TASK-065 §5/§22 (арх. 02 §3.4): порт FileSaver модуля reporting — «диалог → запись
 * файла → путь-результат». Боевая реализация — Electron-адаптер main/platform
 * (dialog.showSaveDialog + writeFile); тесты подставляют мок-интерфейс порта
 * (§22: «dialog API в тестах — мок-интерфейс FileSaver уже порт, тестируется чисто»).
 *
 * Результат (§7): `ExportFileResult = {path} | {canceled: true}` — отмена диалога —
 * НЕ ошибка (ожидаемый исход, UI тихо); сбой записи — исключение из реализации
 * порта, оркестратор доставляет его как err EXPORT/FAILED (§9/§10).
 *
 * savePdf (§5 «pdf — TASK-068», §23 «точки расширения готовы»): бинарный контент —
 * потребность появится с PDF-отчётом; форма порта зафиксирована заранее, чтобы
 * TASK-068 подключился без смены контракта.
 */

/** Результат сохранения (§7): путь выбранного файла или отмена пользователя. */
export type ExportFileResult = { readonly path: string } | { readonly canceled: true };

/** Порт сохранения файлов экспорта (§5): имя по умолчанию + содержимое → путь/отмена. */
export interface ExportFileSaver {
  /** CSV-выгрузка (§5): содержимое — строка (BOM+заголовок+записи, use case 063). */
  saveCsv(defaultName: string, csv: string): Promise<ExportFileResult>;
  /** JSON-слепок (§5): содержимое — строка (мастер-формат 064). */
  saveJson(defaultName: string, json: string): Promise<ExportFileResult>;
  /** PDF-отчёт (§5: «pdf — TASK-068»): бинарный контент воркера (TASK-067). */
  savePdf(defaultName: string, pdf: Uint8Array): Promise<ExportFileResult>;
}
