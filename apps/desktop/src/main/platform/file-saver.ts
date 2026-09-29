/**
 * TASK-065 §5/§6 (арх. 02 §3.4): боевой FileSaver поверх Electron — save-диалог ОС
 * (dialog.showSaveDialog, §3: диалог выбора места — ВСЕГДА, никаких «тихих» записей)
 * + запись файла (writeFile, кодировка utf8 для CSV/JSON).
 *
 * Electron импортируется ЛЕНИВО внутри save() (§20-прецедент DialogFileSaver/
 * SafeStorageKeyVault): в node-окружении vitest save() не вызывается (тесты
 * подставляют мок-интерфейс порта, §22), а статического импорта electron в графе
 * модулей нет — адаптер живёт в main/platform и собирается контейнером.
 *
 * БЕЗОПАСНОСТЬ (§14): путь файла — РЕЗУЛЬТАТ диалога ОС; renderer присылает только
 * тип экспорта, записи в путь от renderer не существует архитектурно. Каналы
 * получают полный путь только как ответ (пользователь сам его выбрал); в ЛОГ —
 * basename (§18, oркестратор).
 *
 * ОТМЕНА (§7): canceled/пустой filePath → {canceled: true} — не ошибка. Вне
 * Electron-рантайма диалог недоступен — честное исключение (не тихий сбой);
 * оркестратор доставит его как err EXPORT/FAILED с cause.
 */
import { writeFile } from 'node:fs/promises';

import type {
  ExportFileResult,
  ExportFileSaver,
} from '../modules/reporting/application/ports/export-file-saver.js';

/** Минимальная поверхность dialog.showSaveDialog (structural, §19-прецедент SaveDialogApi). */
export interface SaveDialogApi {
  showSaveDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

/** Фильтры диалога (§17): описания на EN-идентификаторах + расширения. */
const CSV_FILTERS = [{ name: 'CSV', extensions: ['csv'] }];
const JSON_FILTERS = [{ name: 'JSON', extensions: ['json'] }];
const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }];

/** Боевой сохранитель экспорта (§5): диалог → writeFile → {path} | {canceled}. */
export class ElectronFileSaver implements ExportFileSaver {
  /** CSV (§5): строка с BOM/заголовком — utf8. */
  saveCsv(defaultName: string, csv: string): Promise<ExportFileResult> {
    return this.save(defaultName, CSV_FILTERS, csv);
  }

  /** JSON-слепок (§5): человекочитаемая строка — utf8. */
  saveJson(defaultName: string, json: string): Promise<ExportFileResult> {
    return this.save(defaultName, JSON_FILTERS, json);
  }

  /** PDF-отчёт (§5: pdf — TASK-068): бинарный контент воркера — без кодировки. */
  savePdf(defaultName: string, pdf: Uint8Array): Promise<ExportFileResult> {
    return this.save(defaultName, PDF_FILTERS, pdf);
  }

  /** Общий путь: диалог (§3 — всегда) → запись → результат порта (§7). */
  private async save(
    defaultName: string,
    filters: { name: string; extensions: string[] }[],
    content: string | Uint8Array,
  ): Promise<ExportFileResult> {
    const electron = await import('electron');
    const dialog = (electron as { dialog?: SaveDialogApi }).dialog;
    if (dialog === undefined) {
      throw new Error('ElectronFileSaver: dialog.showSaveDialog недоступен (запуск вне Electron?)');
    }
    const result = await dialog.showSaveDialog({
      title: 'Health Log',
      defaultPath: defaultName,
      filters,
    });
    if (result.canceled || result.filePath === undefined || result.filePath === '') {
      return { canceled: true };
    }
    // CSV/JSON — utf8 (§5); PDF — бинарный буфер без кодировки (TASK-068).
    await writeFile(result.filePath, content, typeof content === 'string' ? 'utf8' : undefined);
    return { path: result.filePath };
  }
}
