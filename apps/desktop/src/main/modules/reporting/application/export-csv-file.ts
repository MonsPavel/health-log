/**
 * TASK-065 §5/§6: use case ExportCsvFile — оркестрация файлового экспорта CSV
 * (US-27): FileOpQueue (§9 — не пересекается с копией БД) → генерация use case'ом
 * ExportCsv (TASK-063) → запись через порт FileSaver (диалог+writeFile — боевой
 * адаптер main/platform/file-saver.ts).
 *
 * Слой — композиция готовых частей, своей логики нет:
 *  - имя файла по умолчанию (§13) и телеметрия §18 — в runQueuedExport (export-file.ts);
 *  - сбой генерации — err внутреннего use case как есть (свой лог внутри, §9);
 *  - сбой записи — err EXPORT/FAILED (§10/§11: диск/права → тост failed+hint);
 *  - отмена диалога — ok {canceled: true} (§7: не ошибка).
 */
import { ok, type AppError, type Clock, type Result } from '@hl/kernel';

import type { ExportCsvUseCase } from './export-csv.js';
import { runQueuedExport, type ExportFileLogger, type FileOpRunner } from './export-file.js';
import type { ExportFileResult, ExportFileSaver } from './ports/export-file-saver.js';

/** Зависимости конструктора (§7): подстановочные в тестах (§19/§22). */
export interface ExportCsvFileDeps {
  /** Генератор содержимого — use case TASK-063 (возвращает csv-строку, ничего не пишет). */
  readonly generate: ExportCsvUseCase;
  /** Порт сохранения (диалог + запись), боевой — ElectronFileSaver (§5). */
  readonly saver: ExportFileSaver;
  /** Общая очередь файловых операций (§9: инстанс один в контейнере). */
  readonly queue: FileOpRunner;
  /** Порт времени: имя файла по умолчанию (§13 — локальное время). */
  readonly clock: Clock;
  readonly logger: ExportFileLogger;
}

/** Use case файлового экспорта CSV (§5): execute(profileId) → {path} | {canceled}. */
export class ExportCsvFileUseCase {
  constructor(private readonly deps: ExportCsvFileDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, отмена — ok-ветка (§7). */
  execute(profileId: string): Promise<Result<ExportFileResult, AppError>> {
    return runQueuedExport({
      kind: 'csv',
      queue: this.deps.queue,
      clock: this.deps.clock,
      logger: this.deps.logger,
      // Форма генератора унифицируется: {csv, count} (063) → {content, count}.
      generate: async () => {
        const generated = await this.deps.generate.execute(profileId);
        return generated.ok
          ? ok({ content: generated.value.csv, count: generated.value.count })
          : generated;
      },
      save: (defaultName, content) => this.deps.saver.saveCsv(defaultName, content),
    });
  }
}
