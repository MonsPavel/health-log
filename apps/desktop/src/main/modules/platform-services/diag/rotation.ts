/**
 * TASK-103 §3/§5/§8: ротация журналов и событий (арх. 04 §7 — retention 90/180
 * дней) — две задачи JobScheduler (TASK-074), выполняются при каждом старте
 * (§5 «интервал — при старте»: runOnStart, живых таймеров нет — §5 074).
 *
 *  - `logs.rotate`: лог-файлы ротируются pino-roll (5 МБ × 5, TASK-010) — задача
 *    удаляет >30-дневные ФАЙЛЫ (по mtime). Открытый дескриптор активного лога на
 *    Windows даёт EPERM/EBUSY — отказ unlink изолируется (warn + продолжение,
 *    §9 074: падение задачи не мешает остальным; best-effort очистки);
 *  - `events.rotate`: DELETE FROM network_event WHERE at_utc < now−90д;
 *    DELETE FROM app_event WHERE at_utc < now−180д — обе DELETE в одной задаче
 *    (единый момент отсчёта ctx.now — детерминизм FixedClock-тестов, §19).
 *
 * ПОРОГИ — строгие («строго старше порога»): запись возраста РОВНО 90/180 дней
 * сохраняется (AC §20-4: 91 удалён / 89 цел; граница — цел).
 *
 * БЕЗОПАСНОСТЬ (§14): удаляются только журналы метаданных и логи (без PHI —
 * контракт TASK-010); измерения/заметки не затрагиваются.
 *
 * ЛОГ (§18): debug-факт с счётчиками удалённого; warn при отказе unlink.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type { JobCtx, JobDefinition } from '../../../shared/scheduler/scheduler.js';

/** Имя задачи удаления старых лог-файлов (§5). */
export const LOGS_ROTATE_JOB_NAME = 'logs.rotate';

/** Имя задачи ротации событий (§5/§8). */
export const EVENTS_ROTATE_JOB_NAME = 'events.rotate';

/** Порог удаления лог-файлов, дней (§5 «удаляет >30-дневные»). */
export const LOGS_RETENTION_DAYS = 30;

/** Порог ротации network_event, дней (§8: арх. 04 §7 — 90). */
export const NETWORK_EVENT_RETENTION_DAYS = 90;

/** Порог ротации app_event, дней (§8: арх. 04 §7 — 180). */
export const APP_EVENT_RETENTION_DAYS = 180;

/** Структурный логгер задач (§18; боевой — createLogger('job') контейнера). */
export interface RotationLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Порты задачи логов (§19: подстановка в тестах — отказ unlink на Windows). */
export interface LogsRotateDeps {
  /** Каталог логов (тот же, что у DiagBundleService — deps.logsDirPath). */
  readonly logsDir: string;
  readonly logger?: RotationLogger;
  /** Удаление файла (боевой — node:fs/promises.unlink; тесты — фейк-отказ). */
  readonly unlink?: (path: string) => Promise<void>;
}

/** Порты задачи событий (§19). */
export interface EventsRotateDeps {
  /** Открытое соединение БД (прокси контейнера — lazy-statement'ы, §8 093). */
  readonly db: EncryptedDatabase;
  readonly logger?: RotationLogger;
}

/** День в миллисекундах (пороги §8). */
const DAY_MS = 86_400_000;

/**
 * Задача `logs.rotate` (§5): удаляет *.log-файлы каталога логов с mtime строго
 * старше 30 дней. Отсутствующий каталог (чистая установка) — не отказ; отказ
 * unlink одного файла (активный лог) — warn, остальные продолжаются (§9 074).
 */
export function createLogsRotateJob(deps: LogsRotateDeps): JobDefinition {
  const removeFile = deps.unlink ?? unlink;
  return {
    name: LOGS_ROTATE_JOB_NAME,
    runOnStart: true,
    run: async (ctx: JobCtx): Promise<null> => {
      const threshold = ctx.now.utcMs - LOGS_RETENTION_DAYS * DAY_MS;
      const entries = await readdir(deps.logsDir).catch(() => [] as string[]);
      let deleted = 0;
      for (const name of entries.sort()) {
        if (!name.endsWith('.log')) {
          continue;
        }
        const filePath = join(deps.logsDir, name);
        const info = await stat(filePath).catch(() => undefined);
        if (info === undefined || !info.isFile() || info.mtimeMs >= threshold) {
          continue; // отсутствующий/не-файл/свежий — не трогаем
        }
        try {
          await removeFile(filePath);
          deleted += 1;
        } catch (cause) {
          // Активный лог на Windows открыт pino-roll — EPERM/EBUSY: изоляция отказа
          // (§9 074), очистка best-effort, остальные файлы продолжают удаляться.
          deps.logger?.warn('logs.rotate: не удалось удалить старый лог-файл', {
            file: name,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      deps.logger?.debug('logs.rotate: ротация лог-файлов завершена', { deleted, threshold });
      return null;
    },
  };
}

/**
 * Задача `events.rotate` (§5/§8): network_event строго старше 90 дней и
 * app_event строго старше 180 дней — DELETE одним моментом отсчёта (ctx.now).
 * better-sqlite3 синхронен — run синхронный по данным, async по контракту каркаса.
 */
export function createEventsRotateJob(deps: EventsRotateDeps): JobDefinition {
  return {
    name: EVENTS_ROTATE_JOB_NAME,
    runOnStart: true,
    run: (ctx: JobCtx): Promise<null> => {
      const networkThreshold = ctx.now.utcMs - NETWORK_EVENT_RETENTION_DAYS * DAY_MS;
      const appThreshold = ctx.now.utcMs - APP_EVENT_RETENTION_DAYS * DAY_MS;
      const networkDeleted = deps.db
        .prepare('DELETE FROM network_event WHERE at_utc < ?')
        .run(networkThreshold).changes;
      const appDeleted = deps.db
        .prepare('DELETE FROM app_event WHERE at_utc < ?')
        .run(appThreshold).changes;
      deps.logger?.debug('events.rotate: ротация событий завершена', {
        networkDeleted,
        appDeleted,
        networkThreshold,
        appThreshold,
      });
      // better-sqlite3 синхронен — Promise-обёртка контракта каркаса (§5 074).
      return Promise.resolve(null);
    },
  };
}
