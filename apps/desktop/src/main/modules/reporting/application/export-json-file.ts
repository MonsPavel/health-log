/**
 * TASK-065 §5/§6: use case ExportJsonFile — оркестрация файлового экспорта
 * JSON-слепка (мастер-формат, US-владение данными): FileOpQueue (§9 — общий с
 * копией БД и CSV-экспортом) → генерация use case'ом ExportJson (TASK-064) →
 * запись через порт FileSaver (боевой адаптер main/platform/file-saver.ts).
 *
 * Паритет ExportCsvFileUseCase (§5 «аналогично»): сбой генерации — err внутреннего
 * use case как есть; сбой записи — err EXPORT/FAILED; отмена диалога — ok
 * {canceled: true} (§7); телеметрия §18 `export json` — в runQueuedExport.
 */
import { ok, type AppError, type Clock, type Result } from '@hl/kernel';

import type { ExportJsonUseCase } from './export-json.js';
import { runQueuedExport, type ExportFileLogger, type FileOpRunner } from './export-file.js';
import type { ExportFileResult, ExportFileSaver } from './ports/export-file-saver.js';

/** Зависимости конструктора (§7): подстановочные в тестах (§19/§22). */
export interface ExportJsonFileDeps {
  /** Генератор слепка — use case TASK-064 (возвращает json-строку, ничего не пишет). */
  readonly generate: ExportJsonUseCase;
  /** Порт сохранения (диалог + запись), боевой — ElectronFileSaver (§5). */
  readonly saver: ExportFileSaver;
  /** Общая очередь файловых операций (§9: инстанс один в контейнере). */
  readonly queue: FileOpRunner;
  /** Порт времени: имя файла по умолчанию (§13 — локальное время). */
  readonly clock: Clock;
  readonly logger: ExportFileLogger;
}

/** Use case файлового экспорта JSON-слепка (§5): execute(profileId) → {path}|{canceled}. */
export class ExportJsonFileUseCase {
  constructor(private readonly deps: ExportJsonFileDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, отмена — ok-ветка (§7). */
  execute(profileId: string): Promise<Result<ExportFileResult, AppError>> {
    return runQueuedExport({
      kind: 'json',
      queue: this.deps.queue,
      clock: this.deps.clock,
      logger: this.deps.logger,
      // Форма генератора унифицируется: {json, count} (064) → {content, count}.
      generate: async () => {
        const generated = await this.deps.generate.execute(profileId);
        return generated.ok
          ? ok({ content: generated.value.json, count: generated.value.count })
          : generated;
      },
      save: (defaultName, content) => this.deps.saver.saveJson(defaultName, content),
    });
  }
}
