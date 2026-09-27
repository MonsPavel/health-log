/**
 * TASK-035 §19/§24 (ревью приёмки TASK-035): сбор диагностики падения e2e.
 *
 * Флейк-политика §19 — «падение = расследование»: причина флэйка первого сохранения
 * (тост fallback errors.internal; истинный код виден только в main-логе) была
 * недоказуема, потому что ротационный лог приложения — ОБЩИЙ файл вне tmp-userData
 * (эмпирика: raw-file entry → имя приложения «Electron» → %APPDATA%/Electron/logs/
 * hl.1.log; в tmp-userData логов НЕТ), и следующий прогон его перезаписывает.
 * collectDiagnostics копирует логи и файлы tmp-userData в каталог падшего теста
 * в test-results — код ошибки repo.add/IPC и факты изоляции (наличие/размер БД и
 * vault.key) сохраняются для расследования.
 *
 * КОНТРАКТ (§19): never-throws — любая ошибка копирования/чтения попадает в
 * манифест.errors, но не маскирует исходную ошибку теста. Манифест — только имена
 * файлов, БЕЗ абсолютных путей (каталог tmp содержит имя Windows-пользователя, §14).
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Опции сборки: источники прогона + каталог приёмки в test-results (§14/§19). */
export interface CollectDiagnosticsOptions {
  /** Каталог tmp-userData упавшего прогона (fixture mkdtemp). */
  readonly userDataDir: string;
  /** Каталог main-логов приложения (%APPDATA%/Electron/logs — см. launch.ts). */
  readonly logsDir: string;
  /** Каталог приёмки: testInfo.outputPath(...) под test-results. */
  readonly destDir: string;
}

/** Манифест собранного: списки имён файлов (без путей, §14) + ошибки копирования. */
interface DiagnosticsManifest {
  readonly collectedAtUtc: string;
  readonly logs: string[];
  readonly userData: string[];
  readonly errors: string[];
}

/** Ротационные логи приложения: активный hl.1.log + старшие ротации (logger.ts §5). */
const LOG_FILE_PATTERN = /^hl(\.\d+)?\.log$/;

/**
 * Копирует диагностику падения (§19): logs/hl*.log, userdata/* (верхний уровень),
 * diagnostics.json. Отсутствующие источники и вложенные каталоги — пропуск с записью
 * в манифест; функция резолвится при любых условиях (never-throws).
 */
export async function collectDiagnostics(options: CollectDiagnosticsOptions): Promise<void> {
  const errors: string[] = [];
  const logs: string[] = [];
  const userData: string[] = [];

  const logsDir = join(options.destDir, 'logs');
  const userDataDestDir = join(options.destDir, 'userdata');

  // --- main-логи приложения: ротационные hl*.log (общий файл — перезаписывается след. прогоном) ---
  if (existsSync(options.logsDir)) {
    try {
      await mkdir(logsDir, { recursive: true });
      for (const name of await readdir(options.logsDir)) {
        if (!LOG_FILE_PATTERN.test(name)) {
          continue;
        }
        try {
          await copyFile(join(options.logsDir, name), join(logsDir, name));
          logs.push(name);
        } catch (cause) {
          errors.push(`logs/${name}: ${String(cause)}`);
        }
      }
    } catch (cause) {
      errors.push(`logs (readdir): ${String(cause)}`);
    }
  } else {
    errors.push(`logs: каталог не найден (${basename(options.logsDir)})`);
  }

  // --- tmp-userData: факты изоляции (БД/-wal/-shm/vault.key — наличие и размер) ---
  if (existsSync(options.userDataDir)) {
    try {
      await mkdir(userDataDestDir, { recursive: true });
      for (const entry of await readdir(options.userDataDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          // Вложенные каталоги не копируем (в tmp их нет; если появятся — событие в манифесте).
          errors.push(`userdata/${entry.name}: пропущен (не файл)`);
          continue;
        }
        try {
          await copyFile(join(options.userDataDir, entry.name), join(userDataDestDir, entry.name));
          userData.push(entry.name);
        } catch (cause) {
          errors.push(`userdata/${entry.name}: ${String(cause)}`);
        }
      }
    } catch (cause) {
      errors.push(`userdata (readdir): ${String(cause)}`);
    }
  } else {
    errors.push('userdata: каталог tmp-userData не найден');
  }

  const manifest: DiagnosticsManifest = {
    collectedAtUtc: new Date().toISOString(),
    logs,
    userData,
    errors,
  };
  try {
    await writeFile(join(options.destDir, 'diagnostics.json'), JSON.stringify(manifest, null, 2));
  } catch {
    // Последняя защита never-throws: без манифеста, но и без броска.
  }
}
