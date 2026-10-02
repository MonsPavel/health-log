/**
 * TASK-100 §2/§5/§7: SelfCheckService — сампроверка при старте приложения.
 * После открытия БД (контейнер): PRAGMA quick_check → ok|corrupt; чтение
 * schema_version; режим vault-а; статус llm-воркера (если ИИ-модуль есть);
 * prefs-валидация (zod уже при чтении — флаг). Результат — иммутабельный снимок
 * SelfCheckReport, хранится в сервисе (контейнер отдаёт его каналу
 * `app/selfcheck`); полная проверка — ОТДЕЛЬНЫЙ запрос `app/integrity-full`,
 * стартовый отчёт не мутирует (§7).
 *
 * РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТЕЙ (§9): самчек ОБНАРУЖИВАЕТ повреждение (dbOk=false)
 — контейнер ПРОДОЛЖАЕТ старт (БД открыта, флаг выставлен), реакцию решает
 * recovery-экран TASK-101. Обёртка openEncrypted с этой задачи НЕ бросает на
 * quick_check≠'ok' (только на неверном ключе SQLITE_NOTADB — STORAGE/BAD_KEY):
 * повреждённая БД остаётся ОТКРЫТОЙ, чтобы отчёт был частично заполнен (§13).
 *
 * ЧАСТИЧНАЯ ДИАГНОСТИКА (§13): каждый шаг изолирован — сбой чтения schema_version
 * даёт 0, сбой prefs-порта даёт false, отчёт при любом раскладе заполнен.
 *
 * KEY_MISSING (§13, задокументировано): vault проверяется ДО открытия БД — отказ
 * ключа уходит в диалог 011/101, контейнер не собирается; самчек после открытия
 * фиксирует только РЕЖИМ (vaultMode) — строка KEY_MISSING в отчёт не попадает.
 *
 * БЕЗОПАСНОСТЬ (§14): поля отчёта — только факты/версии (контракт strict, тест-
 * инвариант AC5); полная проверка возвращает текст PRAGMA integrity_check
 * (служебные сообщения SQLite, без путей/PHI), длина ограничена.
 *
 * ЛОГ (§18): одна строка резюме на старт — info с {dbOk, schemaVersion, startupMs}.
 *
 * ПРОИЗВОДИТЕЛЬНОСТЬ (§15): quick_check 50k ≤100 мс; бюджет сампроверки ≤150 мс —
 * замер в тесте (startupMs — длительность самой проверки, компонент старта).
 */
import type { AppWorkerStateDto, SelfCheckReport } from '@hl/contracts';
import type { Clock } from '@hl/kernel';

import type { EncryptedDatabase } from '../shared/db/sqlite.js';

/** Структурный логгер сервиса (§18; боевой — createLogger('app') контейнера). */
export interface SelfCheckLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Порты сампроверки (§19: подстановка в тестах). */
export interface SelfCheckDeps {
  /** Открытое соединение БД (прокси контейнера — lazy-statement'ы, §8 TASK-093). */
  readonly db: EncryptedDatabase;
  /** Порт времени (checkedAtUtc, замер startupMs). */
  readonly clock: Clock;
  /** Логгер резюме старта (§18). */
  readonly logger?: SelfCheckLogger;
  /** Режим хранилища ключа — фиксируется контейнером при сборке (§13). */
  readonly vaultMode: 'none' | 'passphrase';
  /** Статус llm-воркера; порт отсутствует — поле в отчёт не входит (§5). */
  readonly workerState?: () => AppWorkerStateDto;
  /**
   * Проверка prefs (§5 «zod уже при чтении — флаг»): контейнер передаёт чтение
   * PreferencesService — успех валидации → true, любой отказ → false.
   */
  readonly prefsOk?: () => Promise<boolean>;
}

/** Результат полной проверки (PRAGMA integrity_check) — ответ app/integrity-full. */
export interface FullIntegrityResult {
  readonly ok: boolean;
  readonly details: string;
}

/** Верхняя граница текста details (§14: ограничение IPC-полезной нагрузки). */
const MAX_DETAILS_LENGTH = 4000;

/**
 * Сервис сампроверки (§5): run() — снимок старта (хранится в сервисе),
 * runFullIntegrity() — отдельный тяжёлый запрос по кнопке (§7).
 */
export class SelfCheckService {
  private reportValue: SelfCheckReport | undefined;

  constructor(private readonly deps: SelfCheckDeps) {}

  /** Последний снимок старта; undefined — самчек ещё не выполнялся (locked-старт). */
  get report(): SelfCheckReport | undefined {
    return this.reportValue;
  }

  /**
   * Выполняет сампроверку и сохраняет снимок (§5). Каждый шаг изолирован — при
   * повреждении БД отчёт остаётся частично заполненным (§13).
   */
  async run(): Promise<SelfCheckReport> {
    const startedAt = this.deps.clock.nowMs();
    const dbOk = this.checkQuick();
    const schemaVersion = this.readSchemaVersion();
    const prefsOk = await this.checkPrefs();
    const workerState = this.deps.workerState?.();
    const report: SelfCheckReport = {
      dbOk,
      schemaVersion,
      vaultMode: this.deps.vaultMode,
      ...(workerState === undefined ? {} : { worker: { state: workerState } }),
      prefsOk,
      checkedAtUtc: startedAt,
      startupMs: Math.max(0, this.deps.clock.nowMs() - startedAt),
    };
    this.reportValue = report;
    this.deps.logger?.info('self-check: стартовое резюме', {
      dbOk: report.dbOk,
      schemaVersion: report.schemaVersion,
      startupMs: report.startupMs,
    });
    return report;
  }

  /**
   * Полная проверка БД (§4/§8): PRAGMA integrity_check по кнопке — по умолчанию
   * НЕ выполняется на старте (компромисс скорости §4). Отдельный результат в UI,
   * стартовый снимок не мутирует (§7). Сбой соединения → {ok: false, details}.
   * Синхронна (better-sqlite3 синхронный — прецедент арх. 03 §6): хендлер канала
   * возвращает значение напрямую.
   */
  runFullIntegrity(): FullIntegrityResult {
    try {
      const rows = this.deps.db.pragma('integrity_check') as Array<
        Record<string, unknown> | string
      >;
      // integrity_check возвращает 'ok' или список ошибок (строка на проблему).
      const lines = rows.map((row) => {
        const value: unknown = typeof row === 'string' ? row : row['integrity_check'];
        return typeof value === 'string' ? value : '';
      });
      const details = lines.join('\n').slice(0, MAX_DETAILS_LENGTH);
      return { ok: lines.length === 1 && lines[0] === 'ok', details };
    } catch (cause) {
      this.deps.logger?.warn('self-check: полная проверка не удалась', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      return { ok: false, details: 'integrity_check failed' };
    }
  }

  /** PRAGMA quick_check: 'ok' → целая; строка ошибок → corrupt (§4/§8). */
  private checkQuick(): boolean {
    try {
      return this.deps.db.pragma('quick_check', { simple: true }) === 'ok';
    } catch {
      return false; // нечитаемый отчёт — трактуем как corrupt (частичная диагностика §13)
    }
  }

  /**
   * schema_version из meta (свежая БД — таблицы ещё нет; нечитаемая — сбой):
   * трактуется как 0, «миграций не было» (прецедент readSchemaVersionForLog 027).
   */
  private readSchemaVersion(): number {
    try {
      const row = this.deps.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row !== undefined && /^\d+$/.test(row.value) ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  /** prefs-флаг (§5): отказ порта (в т.ч. закрытая БД) — false, не throw (§13). */
  private async checkPrefs(): Promise<boolean> {
    if (this.deps.prefsOk === undefined) {
      return true;
    }
    try {
      return await this.deps.prefsOk();
    } catch {
      return false;
    }
  }
}
