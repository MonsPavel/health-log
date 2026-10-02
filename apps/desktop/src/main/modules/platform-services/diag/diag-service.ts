/**
 * TASK-103 §2/§5/§7/§9/§13: DiagBundleService — сборка диагностического пакета
 * (zip без PHI, NFR-12) по явному действию пользователя: collect() — содержимое
 * для предпросмотра, saveBundle() — zip в tmp → save-диалог → copy (§9).
 *
 * СОСТАВ ПАКЕТА (§5): лог-файлы (все ротации из logsDir), self-check-отчёт
 * (TASK-100), версии (app/meta: приложение/схема/шкала/модель + системная строка
 * OS/arch/locale — БЕЗ имени пользователя и серийников, §14), журнал сети (200
 * записей — тот же лимит, что privacy/journal TASK-098), агрегаты app_event по
 * kind за 90 дней, список миграций, манифест diag-manifest.json (версия формата,
 * дата). ВСЁ — метаданные/факты (§13): измерения/заметки/чат сборщик не читает
 * принципиально (в deps нет порта к ним — инвариант держится структурой графа;
 * PHI-скан-тест §19/AC §20-1 — страховка процесса).
 *
 * ЗАЩИТНАЯ ВЕТКА (§9): суммарный объём логов ≤ maxLogsBytes (25 МБ) — приемлемо
 * для памяти, preview-тексты включены; > порога — только списки (имя+размер) БЕЗ
 * чтения содержимого (заодно честность замера §15: collect ≤2 с на 25 МБ логов).
 * Сгенерированные json малы — preview всегда.
 *
 * ZIP (§4 РЕШЕНИЕ — archiver): поток zip в tmp → save-диалог (§14: путь выбирает
 * пользователь; renderer путь не присылает) → copyFile к цели + удаление tmp.
 * Отмена диалога — {canceled: true}, tmp чистится (§7 065: отмена — не ошибка).
 *
 * КЭШ (§11): collect кэширует содержимое; saveBundle переиспользует кэш — то,
 * что пользователь видел в предпросмотре, то и уходит в zip (повторного чтения
 * журнала/агрегатов нет — один вызов порта на предпросмотр).
 *
 * ЛОГ (§18): «diag bundle saved files=N sizeMB=…» — факты без путей (userData
 * содержит имя Windows-пользователя).
 */
import { createWriteStream } from 'node:fs';
import { copyFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZipArchive } from 'archiver';

import type { DiagContent, DiagFile, SelfCheckReport } from '@hl/contracts';
import type { Clock } from '@hl/kernel';

/** Версия формата пакета (§5: манифест; эволюция структуры — инкремент). */
export const DIAG_FORMAT_VERSION = 1;

/** Имя манифеста внутри zip (§5). */
export const DIAG_MANIFEST_FILENAME = 'diag-manifest.json';

/** Имя пакета по умолчанию для save-диалога (§11). */
export const DIAG_BUNDLE_DEFAULT_NAME = 'health-log-diag.zip';

/** Лимит записей журнала сети (§5 «privacy/journal 200 записей»). */
export const DIAG_JOURNAL_LIMIT = 200;

/** Окно агрегатов app_event, дней (§5 «за 90 дней»). */
export const DIAG_APP_EVENT_WINDOW_DAYS = 90;

/** Порог суммарного объёма логов для preview (§9: 25 МБ — приемлемо). */
export const DIAG_MAX_LOGS_TOTAL_BYTES = 25 * 1024 * 1024;

/** Первые N строк текстовых файлов в preview (§7). */
export const DIAG_MAX_PREVIEW_LINES = 20;

/** Структура версий из app/meta (§5): шкала/модель опциональны, система — строка ОС. */
export interface DiagVersionInfo {
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly scale?: { readonly code: string; readonly version: string };
  readonly model?: { readonly id: string; readonly version: string };
  readonly system: DiagSystemInfo;
}

/** Системная строка (§5): OS/arch/locale — без имени пользователя/серийников (§14). */
export interface DiagSystemInfo {
  readonly os: string;
  readonly arch: string;
  readonly locale: string;
}

/** Запись журнала сети — метаданные gateway (§7 075: без PHI; bytes NULL → нет поля). */
export interface DiagJournalEntry {
  readonly kind: string;
  readonly endpoint: string;
  readonly status: string;
  readonly bytes?: number;
  readonly atUtc: number;
}

/** Структурный логгер (§18; боевой — createLogger('app') контейнера). */
export interface DiagBundleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Save-диалог main-стороны (§11, паттерн 065): путь выбирает пользователь;
 * null — отмена (ожидаемый исход §7). Боевой адаптер — ленивый electron
 * (createDefaultDiagSaveDialog ниже); тесты подставляют фейк (§19).
 */
export interface DiagSaveDialog {
  save(options: { defaultPath: string }): Promise<string | null>;
}

/** Исход saveBundle — та же union, что ответ канала diag/save (§11/§7 065). */
export type DiagSaveOutcome =
  | { readonly saved: true; readonly path: string }
  | { readonly saved: false; readonly canceled: true };

/** Порты сборщика (§19: подстановка в тестах; боевые — проводка контейнера §6). */
export interface DiagBundleDeps {
  /** Каталог логов (все ротации pino-roll; TASK-072 §5: deps.logsDirPath контейнера). */
  readonly logsDir: string;
  /** Порт времени (манифест, окно агрегатов). */
  readonly clock: Clock;
  /** Версия приложения (app/meta). */
  readonly appVersion: string;
  /** Снимок сампроверки старта (TASK-100); undefined — самчек ещё не выполнялся. */
  readonly selfcheckReport: () => SelfCheckReport | undefined;
  /** Версия схемы БД на момент сборки (app/meta). */
  readonly schemaVersion: () => number;
  /** Активная шкала (app/meta); undefined — не активирована. */
  readonly activeScale: () => Promise<{ code: string; version: string } | undefined>;
  /** Активная модель (app/meta); undefined — не выбрана. */
  readonly model: () => Promise<{ id: string; version: string } | undefined>;
  /** Последние N записей журнала сети (структурно egress.listRecent, TASK-075 §5). */
  readonly networkJournal: (limit: number) => Array<{
    kind: string;
    endpoint: string;
    status: string;
    bytes: number | null;
    atUtc: number;
  }>;
  /**
   * Агрегаты app_event по kind от sinceUtcMs (§5 «по kind count за 90 дней»);
   * SQL — в проводке контейнера (прецедент countMeasurements TASK-074 §5).
   */
  readonly appEventTotals: (sinceUtcMs: number) => Promise<Record<string, number>>;
  /** Реестр миграций (§5 «список миграций+versions»). */
  readonly migrations: ReadonlyArray<{ readonly version: number }>;
  /** Системная строка (§5); контейнер — os + ленивый app.getLocale (§14 без путей). */
  readonly systemInfo: () => Promise<DiagSystemInfo>;
  /** Save-диалог (§11). */
  readonly saveDialog: DiagSaveDialog;
  /** Логгер (§18). */
  readonly logger?: DiagBundleLogger;
  /** Каталог сборки zip до диалога (§9 tmp); по умолчанию tmpdir ОС. */
  readonly tmpDir?: string;
  /** Порог preview-ветки (§9); по умолчанию DIAG_MAX_LOGS_TOTAL_BYTES. */
  readonly maxLogsBytes?: number;
}

/** Первый превью-фрагмент текста (§7): первые 20 строк. */
function previewOf(text: string): string {
  return text.split('\n', DIAG_MAX_PREVIEW_LINES).join('\n');
}

/** Запись журнала gateway → DTO (bytes null → отсутствие поля, §7 098). */
function toJournalEntry(row: {
  kind: string;
  endpoint: string;
  status: string;
  bytes: number | null;
  atUtc: number;
}): DiagJournalEntry {
  return {
    kind: row.kind,
    endpoint: row.endpoint,
    status: row.status,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    atUtc: row.atUtc,
  };
}

/** JSON-строка сгенерированного файла (pretty — читаемо в предпросмотре и в zip). */
function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** День в миллисекундах (окно агрегатов §5). */
const DAY_MS = 86_400_000;

/**
 * Сборщик диагностического пакета (§5). Один экземпляр на приложение (контейнер);
 * состояние — только кэш последнего collect (§11).
 */
export class DiagBundleService {
  private readonly deps: DiagBundleDeps;
  /** Кэш превью-данных (§11): то, что видел предпросмотр, уходит в zip. */
  private cachedContent: DiagContent | undefined;

  constructor(deps: DiagBundleDeps) {
    this.deps = deps;
  }

  /**
   * Собирает содержимое пакета в памяти (§5/§9) и кэширует его (§11). Отсутствие
   * каталога логов (чистая установка) — не отказ: список честно отражает
   * доступное (логов нет — файлов .log нет); отказы портов пробрасываются выше
   * (канал конвертирует в APP/INTERNAL, §11).
   */
  async collect(): Promise<DiagContent> {
    const nowMs = this.deps.clock.nowMs();

    // Логи (все ротации pino-roll): *.log-файлы каталога, детерминированный порядок.
    const entries = (await readdir(this.deps.logsDir).catch(() => [] as string[])).sort();
    const logNames: string[] = [];
    const sizes = new Map<string, number>();
    let logsTotal = 0;
    for (const name of entries) {
      const info = await stat(join(this.deps.logsDir, name)).catch(() => undefined);
      if (info === undefined || !info.isFile() || !name.endsWith('.log')) {
        continue;
      }
      logNames.push(name);
      sizes.set(name, info.size);
      logsTotal += info.size;
    }

    const files: DiagFile[] = [];
    const previewLogs = logsTotal <= (this.deps.maxLogsBytes ?? DIAG_MAX_LOGS_TOTAL_BYTES);
    for (const name of logNames) {
      const sizeBytes = sizes.get(name) ?? 0;
      if (!previewLogs) {
        files.push({ name, sizeBytes }); // §9 защитная ветка: только списки
        continue;
      }
      const text = await readFile(join(this.deps.logsDir, name), 'utf8');
      files.push({ name, sizeBytes, preview: previewOf(text) });
    }

    // Сгенерированные файлы (§5) — малы, preview всегда (§7).
    const totals = await this.deps.appEventTotals(nowMs - DIAG_APP_EVENT_WINDOW_DAYS * DAY_MS);
    const scale = await this.deps.activeScale();
    const model = await this.deps.model();
    const system = await this.deps.systemInfo();
    const versions: DiagVersionInfo = {
      appVersion: this.deps.appVersion,
      schemaVersion: this.deps.schemaVersion(),
      ...(scale === undefined ? {} : { scale }),
      ...(model === undefined ? {} : { model }),
      system,
    };
    const generated: Array<{ name: string; text: string }> = [
      { name: 'versions.json', text: jsonText(versions) },
      { name: 'selfcheck.json', text: jsonText(this.deps.selfcheckReport() ?? null) },
      {
        name: 'network-journal.json',
        text: jsonText({
          limit: DIAG_JOURNAL_LIMIT,
          entries: this.deps.networkJournal(DIAG_JOURNAL_LIMIT).map(toJournalEntry),
        }),
      },
      {
        name: 'app-events.json',
        text: jsonText({ windowDays: DIAG_APP_EVENT_WINDOW_DAYS, eventsByKind: totals }),
      },
      {
        name: 'migrations.json',
        text: jsonText(this.deps.migrations.map((migration) => ({ version: migration.version }))),
      },
      {
        name: DIAG_MANIFEST_FILENAME,
        text: jsonText({ formatVersion: DIAG_FORMAT_VERSION, createdAtUtc: nowMs }),
      },
    ];
    for (const file of generated) {
      files.push({
        name: file.name,
        sizeBytes: Buffer.byteLength(file.text, 'utf8'),
        preview: previewOf(file.text),
      });
    }

    const content: DiagContent = { files, totals: { eventsByKind: totals } };
    this.cachedContent = content;
    return content;
  }

  /**
   * Сохраняет пакет (§9/§11): содержимое — кэш collect либо свежая сборка;
   * zip-стрим в tmp → save-диалог → copyFile к цели → tmp удаляется. Отмена
   * диалога — {canceled: true} (§7 065). Лог §18 — факты без путей.
   */
  async saveBundle(): Promise<DiagSaveOutcome> {
    const content = this.cachedContent ?? (await this.collect());
    const tmpZipPath = join(
      this.deps.tmpDir ?? tmpdir(),
      `health-log-diag-${process.pid}-${this.deps.clock.nowMs()}.zip`,
    );
    try {
      const totalBytes = await this.writeZip(tmpZipPath, content);
      const targetPath = await this.deps.saveDialog.save({
        defaultPath: DIAG_BUNDLE_DEFAULT_NAME,
      });
      if (targetPath === null || targetPath === '') {
        return { saved: false, canceled: true }; // §7 065: отмена — не ошибка
      }
      await copyFile(tmpZipPath, targetPath);
      const sizeMB = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
      this.deps.logger?.info('diag bundle saved', { files: content.files.length, sizeMB });
      return { saved: true, path: targetPath };
    } finally {
      // tmp чист в любом исходе (успех — копия у цели; отмена/ошибка — заготовка удалена).
      await rm(tmpZipPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Записывает zip-стрим в путь (§9 «zip-стрим в tmp»); возвращает размер архива.
   * Файлы пакета добавляются строками: логи перечитываются с ФС на момент
   * сохранения (сборка в памяти §9 — до 25 МБ), сгенерированные json — из
   * содержимого сборки.
   */
  private async writeZip(targetPath: string, content: DiagContent): Promise<number> {
    const sink = createWriteStream(targetPath);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    const failure = new Promise<never>((_, reject) => {
      zip.on('error', reject);
      sink.on('error', reject);
    });
    const finished = new Promise<void>((resolve, reject) => {
      sink.on('finish', resolve);
      sink.on('error', reject);
    });
    zip.pipe(sink);
    for (const file of content.files) {
      const text = file.name.endsWith('.log')
        ? await readFile(join(this.deps.logsDir, file.name), 'utf8')
        : (file.preview ?? '');
      zip.append(text, { name: file.name });
    }
    // archiver v8: finalize возвращает void-подобное значение — финал архива
    // отслеживается 'finish' приёмника ниже (smoke-прогон §4).
    void zip.finalize();
    await Promise.race([finished, failure]);
    return (await stat(targetPath)).size;
  }
}

/**
 * Боевой save-диалог (§11): dialog.showSaveDialog Electron, ленивый импорт
 * (§20-прецедент DialogFileSaver 070): в node-окружении vitest save() не
 * вызывается, статического импорта electron в графе нет.
 */
export function createDefaultDiagSaveDialog(): DiagSaveDialog {
  return {
    async save(options: { defaultPath: string }): Promise<string | null> {
      const electron = await import('electron');
      const dialog = (
        electron as {
          dialog?: {
            showSaveDialog(opts: {
              title?: string;
              defaultPath?: string;
              filters?: { name: string; extensions: string[] }[];
            }): Promise<{ canceled: boolean; filePath?: string }>;
          };
        }
      ).dialog;
      if (dialog === undefined) {
        throw new Error(
          'createDefaultDiagSaveDialog: dialog.showSaveDialog недоступен (запуск вне Electron?)',
        );
      }
      const result = await dialog.showSaveDialog({
        title: 'Health Log',
        defaultPath: options.defaultPath,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (result.canceled || result.filePath === undefined || result.filePath === '') {
        return null;
      }
      return result.filePath;
    },
  };
}
