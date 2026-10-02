/**
 * TASK-103 §2/§5/§7/§9/§13: DiagBundleService — сбор диагностического пакета
 * (zip без PHI) и сохранение через save-диалог ОС.
 *
 * ПОТОК (§5): collect() собирает содержимое В ПАМЯТИ (логи ≤25 МБ — приемлемо,
 * §9) и кэширует его — канал `diag/preview` отдаёт DiagContent ДО сохранения
 * (предпросмотр обязателен — AC §20-3, пользователь контролирует публикацию,
 * §14); saveBundle() использует кэш сборки (пустой — собирает сам), пишет zip
 * во tmp (манифест diag-manifest.json: версия формата, дата, §5), открывает
 * save-диалог main (паттерн 065: путь выбирает ОС — renderer путь не шлёт,
 * §14) и переносит файл по выбранному пути. Отмена диалога — {canceled: true},
 * не ошибка (§7); tmp-файл удаляется (гигиена).
 *
 * СОСТАВ ПАКЕТА (§5): лог-файлы (все ротации pino-roll, hl.N.log), отчёт
 * self-check (TASK-100, факт «ещё не выполнялась» — null), версии (форма
 * app/meta), журнал сети (privacy/journal 200 записей — метаданные gateway,
 * контракт сортировки/лимита — TASK-075), агрегаты app_event по kind за 90
 * дней, список версий миграций, системная строка (OS/arch/locale — без имени
 * пользователя/серийников, §14).
 *
 * PHI-ИНВАРИАНТЫ (§13 — тест-скан главной гарантией): логи уже редактированы
 * (контракт TASK-010), network_event/app_event — ТОЛЬКО метаданные/агрегаты
 * (payload_json не читается), self-check — факты. НИКАКИХ измерений/заметок/
 * чата. Каждый источник изолирован (частичная диагностика, прецедент
 * SelfCheckService §13): отказ чтения БД/логов — warn и пропуск источника,
 * а не крах сборки.
 *
 * ЗАЩИТНАЯ ВЕТКА (§9): суммарный размер логов > порога (25 МБ) — preview-
 * тексты логов не читаются (только список имя+размер); сгенерированные
 * тексты (JSON/системная строка) малы и предпросматриваются всегда.
 *
 * ЛОГ (§18): `diag bundle saved files=N sizeMB=…` после успешного сохранения.
 *
 * ТЕСТИРУЕМОСТЬ (§19): порты db/clock/journal/versions/system/saver/logger —
 * подстановка в тестах; боевые — контейнер (egress.listRecent, app/meta
 * источники, ElectronFileSaver-подобный диалог).
 */
import { createWriteStream } from 'node:fs';
import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import archiver from 'archiver';
import {
  DIAG_BUNDLE_FORMAT_VERSION,
  type DiagContent,
  type DiagFileEntry,
  type DiagSaveResponse,
  type SelfCheckReport,
} from '@hl/contracts';
import type { Clock } from '@hl/kernel';

import type { Migration } from '../../../shared/db/migration-runner.js';
import type { EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type { NetworkEventRow } from '../egress/egress-gateway.js';

/** Лимит записей журнала сети в пакете (§5: privacy/journal 200 записей). */
export const DIAG_JOURNAL_LIMIT = 200;

/** Окно агрегатов app_event в пакете, дней (§5; порог ротации §8 — 180, окно — 90). */
export const DIAG_EVENT_WINDOW_DAYS = 90;

/** Строк в превью текстового файла (§7). */
export const DIAG_PREVIEW_LINES = 20;

/** Порог суммарного размера логов для чтения preview-текстов (§9: 25 МБ). */
export const DIAG_MAX_LOG_BYTES_FOR_PREVIEW = 25 * 1024 * 1024;

/** Имя манифеста в корне пакета (§5). */
export const DIAG_MANIFEST_NAME = 'diag-manifest.json';

/** Подкаталог логов в пакете. */
export const DIAG_LOGS_DIRNAME = 'logs';

/** Имена лог-файлов pino-roll v4 (активный hl.1.log + ротации, TASK-010). */
const LOG_FILE_PATTERN = /^hl\.\d+\.log$/;

/** Минимальная поверхность логгера (§18; HlLogger ей удовлетворяет). */
export interface DiagBundleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Системная строка пакета (§5: OS, arch, locale — без имени пользователя). */
export interface DiagSystemInfo {
  readonly os: string;
  readonly arch: string;
  readonly locale: string;
}

/** Версии пакета (§5 «версии (app/meta)» — форма ответа канала без recovery). */
export interface DiagVersionsInfo {
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly scale?: { readonly code: string; readonly version: string };
  readonly model?: { readonly id: string; readonly version: string };
}

/** Результат диалога сохранения (структурно ExportFileResult TASK-065). */
export type DiagSaveDialogResult = { readonly path: string } | { readonly canceled: true };

/** Зависимости сервиса (§19: подстановка в тестах; боевые — контейнер). */
export interface DiagBundleDeps {
  /** Открытое соединение БД (агрегаты app_event; прокси контейнера, §8 TASK-093). */
  readonly db: EncryptedDatabase;
  /** Порт времени (манифест, окно агрегатов, имя файла по умолчанию). */
  readonly clock: Clock;
  /** Каталог логов (deps.logsDirPath контейнера; TASK-072 §5). */
  readonly logsDir: string;
  /** Снимок сампроверки (TASK-100; report: undefined — честный null в пакете). */
  readonly selfcheck: { readonly report: SelfCheckReport | undefined };
  /** Журнал сети (боевой — EgressGateway.listRecent; контракт сортировки — 075). */
  readonly journal: (limit: number) => NetworkEventRow[];
  /** Версии (форма app/meta: приложение/схема/шкала/модель — резолвит контейнер). */
  readonly versions: () => Promise<DiagVersionsInfo>;
  /** Системная строка (§5); боевой — os.platform/arch + Intl.locale в контейнере. */
  readonly system: () => DiagSystemInfo;
  /** Диалог сохранения (§11 паттерн 065; боевой — electron dialog в контейнере). */
  readonly saver: (defaultName: string) => Promise<DiagSaveDialogResult>;
  /** Каталог tmp для zip-стрима до диалога (§9: zip в tmp → save dialog → move). */
  readonly tmpDir: string;
  /** Логгер (§18). */
  readonly logger?: DiagBundleLogger;
  /** Порог preview-текстов логов (§9); боевой — 25 МБ, тесты — меньше. */
  readonly maxLogBytesForPreview?: number;
}

/** Запись собранного пакета (внутренняя): текст в памяти ИЛИ файл на диске. */
interface DiagBundleEntry {
  /** Логическое имя в пакете ('selfcheck.json', 'logs/hl.1.log'). */
  readonly name: string;
  /** Размер содержимого, байты. */
  readonly sizeBytes: number;
  /** Текстовое содержимое (малы/уже в памяти); нет — поток из sourcePath. */
  readonly text?: string;
  /** Путь на диске (логи защитной ветки §9 — тексты в память не читаются). */
  readonly sourcePath?: string;
}

/** Кэш последней сборки (§5 «preview-данные сохранены в кэш»). */
interface DiagBundleCache {
  readonly entries: readonly DiagBundleEntry[];
  readonly totals: DiagContent['totals'];
}

/** Первые N строк текста (§7) — превью в предпросмотре. */
function firstLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(0, count).join('\n');
}

/** Строка журнала gateway → DTO-метаданные (прецедент toEventDto TASK-098 §5). */
function toEventDto(row: NetworkEventRow): Record<string, unknown> {
  return {
    kind: row.kind,
    endpoint: row.endpoint,
    status: row.status,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    atUtc: row.atUtc,
  };
}

/** Сервис диагностического пакета (§5). Один экземпляр на приложение (container). */
export class DiagBundleService {
  private readonly deps: DiagBundleDeps;

  private cache: DiagBundleCache | undefined;

  constructor(deps: DiagBundleDeps) {
    this.deps = deps;
  }

  /**
   * Собирает содержимое пакета (§5) и кэширует его для saveBundle (§14:
   * пользователь сохраняет ровно то, что предпросмотрел). Каждый источник
   * изолирован — отказ одного не роняет сборку (прецедент самчека §13 100).
   */
  async collect(): Promise<DiagContent> {
    const entries: DiagBundleEntry[] = [];

    // Факты сампроверки (§13): снимок или честный null («ещё не выполнялась»).
    entries.push(this.textEntry('selfcheck.json', JSON.stringify(this.deps.selfcheck.report ?? null, null, 2)));

    // Версии (app/meta, §5) — отказ порта не роняет сборку.
    try {
      const versions = await this.deps.versions();
      entries.push(this.textEntry('versions.json', JSON.stringify(versions, null, 2)));
    } catch (cause) {
      this.deps.logger?.warn('diag: версии недоступны', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    // Журнал сети — DTO-метаданные (без id), лимит 200 (§5).
    try {
      const events = this.deps.journal(DIAG_JOURNAL_LIMIT).map(toEventDto);
      entries.push(this.textEntry('network-events.json', JSON.stringify(events, null, 2)));
    } catch (cause) {
      this.deps.logger?.warn('diag: журнал сети недоступен', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    // Агрегаты app_event по kind за окно 90 дней (§5/§8); payload_json не читается.
    const totals = await this.collectEventTotals();
    entries.push(
      this.textEntry(
        'events.json',
        JSON.stringify({ windowDays: DIAG_EVENT_WINDOW_DAYS, eventsByKind: totals.eventsByKind }, null, 2),
      ),
    );

    // Список версий миграций (§5).
    entries.push(
      this.textEntry(
        'migrations.json',
        JSON.stringify({ versions: this.deps.migrationsList() }, null, 2),
      ),
    );

    // Системная строка (§5): OS/arch/locale, без имени пользователя/серийников (§14).
    const system = this.deps.system();
    entries.push(
      this.textEntry(
        'system.txt',
        `os=${system.os}\narch=${system.arch}\nlocale=${system.locale}\n`,
      ),
    );

    // Логи (все ротации pino-roll): ≤ порога — тексты в памяти (preview, §7);
    // > порога — только список имя+размер (защитная ветка §9).
    entries.push(...(await this.collectLogEntries()));

    this.cache = { entries, totals };
    return {
      files: entries.map(toFileEntry),
      totals,
    };
  }

  /**
   * Сохраняет пакет (§5/§9/§11): zip собранного (кэш или свежая сборка) во tmp
   * с манифестом → save-диалог → перенос по выбранному пути. Отмена —
   * {canceled: true} (не ошибка, §7), tmp убирается. Успех — лог §18.
   */
  async saveBundle(): Promise<DiagSaveResponse> {
    const bundle = this.cache ?? (await this.collect());
    const stamp = new Date(this.deps.clock.nowMs()).toISOString().replace(/[:.]/g, '-');
    const tmpZip = join(this.deps.tmpDir, `health-log-diag-${stamp}.zip`);
    const bytes = await this.writeZip(tmpZip, bundle.entries);
    try {
      const dialog = await this.deps.saver(this.defaultName());
      if (dialog.canceled) {
        await rm(tmpZip, { force: true });
        return { canceled: true };
      }
      await copyFile(tmpZip, dialog.path);
      // §18: `diag bundle saved files=N sizeMB=…` — без путей (basename не нужен:
      // путь выбирал пользователь, в лог идут факты размера/состава).
      this.deps.logger?.info('diag bundle saved', {
        files: bundle.entries.length,
        sizeMB: Math.round((bytes / (1024 * 1024)) * 100) / 100,
      });
      return { path: dialog.path };
    } finally {
      // Гигиена tmp (§9): zip во tmp живёт только до переноса/отмены/сбоя.
      await rm(tmpZip, { force: true });
    }
  }

  /**
   * Агрегаты app_event (§5): kind → COUNT за окно 90 дней. Отказ чтения
   * (закрытое соединение и др.) — пустая карта и warn, не крах (§13).
   */
  private async collectEventTotals(): Promise<DiagContent['totals']> {
    const cutoff = this.deps.clock.nowMs() - DIAG_EVENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    try {
      const rows = this.deps.db
        .prepare(
          'SELECT kind, COUNT(*) AS count FROM app_event WHERE at_utc >= ? GROUP BY kind ORDER BY kind',
        )
        .all(cutoff) as Array<{ kind: string; count: number }>;
      const eventsByKind: Record<string, number> = {};
      for (const row of rows) {
        eventsByKind[row.kind] = row.count;
      }
      return { eventsByKind };
    } catch (cause) {
      this.deps.logger?.warn('diag: агрегаты app_event недоступны', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      return { eventsByKind: {} };
    }
  }

  /**
   * Лог-файлы пакета (§5 «все ротации»): имена pino-roll hl.N.log. Суммарно
   * ≤ порога — читаются в память (preview); больше — только имя+размер (§9).
   */
  private async collectLogEntries(): Promise<Promise<DiagBundleEntry[]> | DiagBundleEntry[]> {
    let names: string[];
    try {
      names = (await readdir(this.deps.logsDir)).filter((name) => LOG_FILE_PATTERN.test(name));
    } catch {
      // Каталога логов нет (initFileLogging ещё не создавал) — источник пуст.
      return [];
    }
    names.sort();
    const paths = names.map((name) => join(this.deps.logsDir, name));
    const sizes = await Promise.all(paths.map((path) => stat(path).then((s) => s.size, () => 0)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const readText = total <= (this.deps.maxLogBytesForPreview ?? DIAG_MAX_LOG_BYTES_FOR_PREVIEW);
    return names.map((name, index) => ({
      name: `${DIAG_LOGS_DIRNAME}/${name}`,
      sizeBytes: sizes[index] ?? 0,
      ...(readText ? { text: undefined } : {}),
      ...(readText
        ? { textPromise: readFile(paths[index] ?? '', 'utf8') as unknown }
        : { sourcePath: paths[index] }),
    })) as DiagBundleEntry[];
  }

  /** Записывает zip с манифестом (§5) во tmp; возвращает размер архива, байты. */
  private async writeZip(targetPath: string, entries: readonly DiagBundleEntry[]): Promise<number> {
    const manifest = Buffer.from(
      JSON.stringify(
        { formatVersion: DIAG_BUNDLE_FORMAT_VERSION, createdAtUtc: this.deps.clock.nowMs() },
        null,
        2,
      ),
      'utf8',
    );
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = createWriteStream(targetPath);
    const closed = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', reject);
      output.on('error', reject);
    });
    archive.pipe(output);
    archive.append(manifest, { name: DIAG_MANIFEST_NAME });
    for (const entry of entries) {
      if (typeof entry.text === 'string') {
        archive.append(Buffer.from(entry.text, 'utf8'), { name: entry.name });
      } else if (entry.sourcePath !== undefined) {
        archive.file(entry.sourcePath, { name: entry.name });
      }
    }
    await archive.finalize();
    await closed;
    return output.bytesWritten;
  }

  /** Имя по умолчанию для диалога (дата — UTC-день момента сборки). */
  private defaultName(): string {
    return `health-log-diag-${new Date(this.deps.clock.nowMs()).toISOString().slice(0, 10)}.zip`;
  }

  /** Текстовая запись пакета: размер — байты utf8-строки. */
  private textEntry(name: string, text: string): DiagBundleEntry {
    return { name, sizeBytes: Buffer.byteLength(text, 'utf8'), text };
  }
}

/**
 * Реестр миграций не входит в deps напрямую (требование читаемости deps):
 * сервис берёт его через легкую функцию-порт, контейнер передаёт MIGRATIONS.
 */
declare module './diag-service.js' {}

/** Запись предпросмотра из внутренней записи (§7: текст есть — превью есть). */
function toFileEntry(entry: DiagBundleEntry): DiagFileEntry {
  return {
    name: entry.name,
    sizeBytes: entry.sizeBytes,
    ...(typeof entry.text === 'string' ? { preview: firstLines(entry.text, DIAG_PREVIEW_LINES) } : {}),
  };
}
