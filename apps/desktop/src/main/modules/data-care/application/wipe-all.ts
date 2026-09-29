/**
 * TASK-072 §5: use case WipeAllData — полное удаление данных пользователя:
 * двухшаговое подтверждение → фактическое удаление (БД + wal/shm + ключ + логи +
 * копии) → перезапуск; приложение возвращается в состояние «как после установки»
 * (§2: новая БД+ключ создадутся автоматически — путь первого запуска TASK-023/025).
 *
 * ДВЕ ФАЗЫ (§5/§13 — plan и execute два явных вызова, не таймер — защита от
 * двойного клика; каждый execute требует СВОЕГО plan):
 *  - фаза plan — ТОЛЬКО чтение (§5 «не удаляет!»): собирает список файлов к
 *    удалению из фактических каталогов main и счётчик измерений; НИЧЕГО не
 *    удаляет, БД не закрывает;
 *  - фаза execute — удаление: сверка состояния → checkpoint+close → unlink по
 *    списку (по одному, лог каждого — §18) → relaunch (§9: отложенно — ответ
 *    канала уходит рендереру до выхода, деталь контейнера — прецедент 071).
 *
 * ПЛАН (§7): `WipePlan {files: [{path: '<basename>', category}], counts,
 * rendererLocalStorage}`. Пути от renderer не принимаются — план строит main из
 * фактических каталогов (§14: renderer не командует файлами); наружу — только
 * basename (полный путь userData содержит имя Windows-пользователя, §14).
 * `rendererLocalStorage` — команда renderer'у очистить localStorage-черновики
 * (§5/§10: ПОСЛЕ подтверждённого execute и ПЕРЕД relaunch; юнит-хелпер —
 * src-renderer/lib/wipe-local-storage.ts, подключение — TASK-073).
 *
 * ПОРЯДОК execute (§9):
 *  1. требование двухшаговости: plan не был → отказ (AC-4);
 *  2. план пересобран и сверён (файлы должны существовать из plan; появился новый
 *     файл — тоже расхождение: строгая сверка множеств, «стереть всё» не должна
 *     молча пропустить появившееся) — расхождение → отказ, состояние изменилось
 *     (ротация лога между фазами — честный отказ, пользователь повторяет plan);
 *  3. закрытие БД (checkpoint TRUNCATE + close — точка контейнера);
 *  4. unlink по списку в ПОРЯДКЕ ПЛАНА (§19 РЕШЕНИЕ: backups → logs → key → db —
 *     БД ПОСЛЕДНЕЙ: частичный сбой оставляет читаемое состояние; внутри группы db
 *     основной файл — последним);
 *  5. успех → relaunch; частичный unlink-сбой → собрать оставшиеся в ошибку
 *     (не молча), НЕ перезапускать (§9: полуживое состояние хуже — пользователь
 *     видит ошибку, документация).
 *
 * Ошибки (§5/§11/§13): наружу только AppError значением Result (прецедент 070/071):
 *  - WIPE/FAILED — единственный код канала: сбой операции, отказ двухшаговости
 *    (execute без plan), расхождение состояния с моментом plan, частичный unlink.
 *    «Что осталось» (§11): полный список remaining (basenames) — в cause (память
 *    main, §14: логам поддержки), в params — remainingCount (число; AppErrorParams
 *    — string|number, массив через IPC не идёт — конвенция contracts app-error-dto).
 *    [РЕШЕНИЕ-ТРАКТОВКА: «error.details» спека §5 — поле AppError не имеет; пары
 *    params+cause покрывают обе потребности — UI и аудит.]
 *
 * Черновики localStorage (§10): удаляет РЕНДЕРЕР (хелпер + подключение 073) — main
 * localStorage рендерера не видит; план лишь обязывает UI показать пункт в
 * подтверждении (rendererLocalStorage: true).
 *
 * Безопасность (§14): renderer не передаёт путей (команда — только {phase});
 * unlink — только из фактического плана main; лог удалений — по basename (без
 * значений и полных путей). Ключ шифрования удалён = криптографическое стирание
 * (§4: «восстановленные» форензикой файлы — мусор без ключа).
 *
 * Лог (§18): `wipe plan` {files, measurements} → `wipe execute` → `wipe file
 * deleted` {category, file} на каждый unlink → `wipe success` {files}; сбои —
 * error с кодом и remainingCount.
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError, type Result } from '@hl/kernel';

import type { BackupDatabase } from './ports/backup-database.js';
import type { FileOpQueue } from './file-op-queue.js';

/** Ключ i18n-каталога (конвенция арх. 05 §29 `errors.<КОД>`); текст — TASK-073/101. */
export const WIPE_FAILED_MESSAGE_KEY = 'errors.WIPE_FAILED';

/** Категория файла плана (§7): db (db+wal+shm) | key (vault.key) | logs | backups. */
export type WipeFileCategory = 'db' | 'key' | 'logs' | 'backups';

/** Запись плана (§7): basename + категория — форма, уходящая renderer'у. */
export interface WipePlanFile {
  /** Имя файла (basename; полный путь остаётся в main, §14). */
  readonly path: string;
  /** Категория — ключ текста подтверждения (§17). */
  readonly category: WipeFileCategory;
}

/** План полного удаления (§7): показывается пользователю ДО подтверждения. */
export interface WipePlan {
  /** Файлы в ПОРЯДКЕ УДАЛЕНИЯ (§19: backups → logs → key → db — БД последней). */
  readonly files: readonly WipePlanFile[];
  /** Счётчик измерений удаляемой БД (факт, не оценка). */
  readonly counts: { readonly measurements: number };
  /** Черновики localStorage очистит renderer после execute (§10; подключение — 073). */
  readonly rendererLocalStorage: true;
}

/** Команда канала (§11: discriminated по phase). */
export interface WipeAllDataCommand {
  /** `plan` — план (только чтение); `execute` — удаление + перезапуск (§5). */
  readonly phase: 'plan' | 'execute';
}

/** Значение результата: план фазы plan или факт запланированного перезапуска execute. */
export type WipeAllDataResultValue = { readonly plan: WipePlan } | { readonly restarting: true };

/** Минимальная поверхность логгера use case (§18; прецедент RestoreBackupLogger). */
export interface WipeAllDataLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Внутренняя запись плана: наружу идут path+category, abs остаётся в main (§14). */
interface WipeFileRecord {
  readonly path: string;
  readonly category: WipeFileCategory;
  /** Полный путь для unlink; наружу (renderer) не уходит (§14). */
  readonly abs: string;
}

/** Зависимости use case (§5): подстановочные в тестах (§19). */
export interface WipeAllDataDeps {
  /** Открытая БД (счётчик измерений плана, §7). */
  readonly db: BackupDatabase;
  /** Закрытие БД (checkpoint TRUNCATE + close — точка контейнера, §8). */
  readonly closeCurrentDb: () => void;
  /** Путь файла БД (-wal/-shm выводятся конвенцией SQLite, §5). */
  readonly dbPath: string;
  /** Путь файла хранилища ключа `<userData>/vault.key` (§5; константа TASK-023). */
  readonly vaultKeyPath: string;
  /** Каталог логов `<userData>/logs` (§5; bootstrap — app.getPath('logs')). */
  readonly logsDir: string;
  /** Каталог копий `<userData>/backups` (§13: копии — тоже данные пользователя). */
  readonly backupsDir: string;
  /** Логгер (§18) — категория db. */
  readonly logger: WipeAllDataLogger;
  /** Очередь файловых операций (§9 070 — сериализация с копиями/экспортами). */
  readonly queue: FileOpQueue;
  /** Планировщик перезапуска (§9; боевой — отложенный relaunch, прецедент 071). */
  readonly relaunch: () => void;
  /**
   * Точка мок-сбоя тестов (§19 «мок chmod-защита»): детерминированный EPERM-stub
   * вместо физического chmod (на Linux права чтения unlink не блокируют). По
   * умолчанию — реальный unlinkSync.
   */
  readonly unlink?: (path: string) => void;
}

/**
 * Use case полного удаления данных (§5). Один экземпляр на приложение (контейнер
 * TASK-027; регистрация канала `data/wipe` — TASK-073). План живёт в экземпляре —
 * двухшаговость привязана к процессу приложения.
 */
export class WipeAllDataUseCase {
  /** План последней фазы plan (§9: execute сверяет и требует его наличия). */
  private plannedFiles: readonly WipeFileRecord[] | undefined;

  constructor(private readonly deps: WipeAllDataDeps) {}

  /** Выполняет фазу (§11); ошибки — значением Result, исключения не пересекают слои. */
  async execute(
    command: WipeAllDataCommand,
  ): Promise<Result<WipeAllDataResultValue, AppError>> {
    // Plan — только чтение: без очереди (прецедент 071). Execute — файловая
    // операция — строго под FileOpQueue (§9 070).
    return command.phase === 'execute'
      ? this.deps.queue.run(() => this.runExecute())
      : this.runPlan();
  }

  /** Фаза plan (§5): список файлов + счётчик; НИЧЕГО не удаляет. */
  private runPlan(): Result<WipeAllDataResultValue, AppError> {
    const startedAtMs = performance.now();
    try {
      const counts = { measurements: countMeasurements(this.deps.db) };
      const files = this.collectFiles();
      // План перезаписывается каждым вызовом plan (повторный plan — не отказ:
      // пользователь вправе пересобрать список; execute сверит по последнему).
      this.plannedFiles = files;
      this.deps.logger.info('wipe plan', {
        files: files.length,
        measurements: counts.measurements,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return {
        ok: true,
        value: {
          plan: {
            files: files.map(({ path, category }) => ({ path, category })),
            counts,
            rendererLocalStorage: true,
          },
        },
      };
    } catch (error) {
      this.deps.logger.error('wipeAllData: сбой построения плана', {
        code: 'WIPE/FAILED',
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: AppError.of('WIPE/FAILED', WIPE_FAILED_MESSAGE_KEY, undefined, error) };
    }
  }

  /** Фаза execute (§5/§9): сверка → закрытие БД → unlink по списку → relaunch. */
  private runExecute(): Result<WipeAllDataResultValue, AppError> {
    const startedAtMs = performance.now();

    // 1. Двухшаговость (§13/AC-4): execute только после plan; план потребляется —
    //    каждый execute требует свежего plan (повтор/двойной клик — отказ).
    const planned = this.plannedFiles;
    this.plannedFiles = undefined;
    if (planned === undefined) {
      this.deps.logger.debug('wipeAllData: execute без plan (отказ двухшаговости)', {
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: errWipe('execute-without-plan') };
    }

    // 2. План пересобран и сверён (§9): файлы должны существовать из plan; новый
    //    файл — тоже расхождение (строгая сверка множеств, §9 «состояние изменилось»).
    const fresh = this.collectFiles();
    if (!sameFiles(planned, fresh)) {
      this.deps.logger.error('wipeAllData: состояние изменилось с момента plan', {
        planned: planned.length,
        current: fresh.length,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return {
        ok: false,
        error: errWipe('plan-outdated', {
          planned: planned.map((file) => file.path),
          current: fresh.map((file) => file.path),
        }),
      };
    }

    this.deps.logger.info('wipe execute', { files: fresh.length });

    // 3. Закрытие БД (§5/§8: checkpoint TRUNCATE + close) — ДО первого unlink;
    //    сбой закрытия → отказ без удаления (читаемое состояние сохранено).
    try {
      this.deps.closeCurrentDb();
    } catch (error) {
      this.deps.logger.error('wipeAllData: сбой закрытия БД (ничего не удалено)', {
        code: 'WIPE/FAILED',
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return { ok: false, error: AppError.of('WIPE/FAILED', WIPE_FAILED_MESSAGE_KEY, undefined, error) };
    }

    // 4. Unlink по списку (§5: по одному, лог каждого; порядок §19 — БД последней).
    const unlink = this.deps.unlink ?? unlinkSync;
    for (let index = 0; index < fresh.length; index += 1) {
      const file = fresh[index] as WipeFileRecord;
      try {
        unlink(file.abs);
      } catch (error) {
        // Файл уже отсутствует — цель (отсутствие) достигнута, не сбой: -wal/-shm
        // SQLite удаляет сам при закрытии соединения (шаг 3) — в плане они есть
        // (на момент сверки соединение ещё открыто), к unlink их уже нет.
        if (isEnoent(error)) {
          this.deps.logger.debug('wipe file already absent', {
            category: file.category,
            file: file.path,
          });
          continue;
        }
        // Частичный сбой (§9/§11): что осталось — в ошибку (не молча), НЕ
        // перезапускать: полуживое состояние хуже (пользователь видит ошибку).
        const remaining = fresh
          .slice(index)
          .filter((record) => existsSync(record.abs))
          .map((record) => record.path);
        this.deps.logger.error('wipeAllData: частичный сбой удаления', {
          category: file.category,
          file: file.path,
          remainingCount: remaining.length,
          code: 'WIPE/FAILED',
          durationMs: Math.round(performance.now() - startedAtMs),
        });
        return {
          ok: false,
          error: AppError.of(
            'WIPE/FAILED',
            WIPE_FAILED_MESSAGE_KEY,
            { remainingCount: remaining.length },
            { reason: 'partial-unlink', remaining, cause: error },
          ),
        };
      }
      this.deps.logger.info('wipe file deleted', { category: file.category, file: file.path });
    }

    // 5. Успех (§5/§9): перезапуск запланирован — приложение стартует в онбординг
    //    (новая БД+ключ создадутся автоматически — путь первого запуска).
    this.deps.logger.info('wipe success', {
      files: fresh.length,
      durationMs: Math.round(performance.now() - startedAtMs),
    });
    this.deps.relaunch();
    return { ok: true, value: { restarting: true } };
  }

  /**
   * Сбор фактических файлов по категориям (§5/§7: из каталогов main, не от
   * renderer'а). Порядок = ПОРЯДОК УДАЛЕНИЯ (§19 РЕШЕНИЕ): backups → logs → key →
   * db; внутри группы db основной файл последним (-wal → -shm → db): любой сбой
   * внутри группы оставляет читаемый файл БД. В пределах категории — сортировка по
   * имени (детерминизм плана: readdir не гарантирует порядок).
   */
  private collectFiles(): readonly WipeFileRecord[] {
    const files: WipeFileRecord[] = [];
    files.push(...listDirFiles(this.deps.backupsDir, 'backups'));
    files.push(...listDirFiles(this.deps.logsDir, 'logs'));
    if (existsSync(this.deps.vaultKeyPath)) {
      files.push({ path: basename(this.deps.vaultKeyPath), category: 'key', abs: this.deps.vaultKeyPath });
    }
    for (const suffix of ['-wal', '-shm']) {
      const abs = `${this.deps.dbPath}${suffix}`;
      if (existsSync(abs)) {
        files.push({ path: basename(abs), category: 'db', abs });
      }
    }
    if (existsSync(this.deps.dbPath)) {
      files.push({ path: basename(this.deps.dbPath), category: 'db', abs: this.deps.dbPath });
    }
    return files;
  }
}

/** Файлы каталога (только regular-файлы, сортировка по имени; нет каталога — []). */
function listDirFiles(dir: string, category: WipeFileCategory): WipeFileRecord[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ path: entry.name, category, abs: join(dir, entry.name) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Ошибка «нет такого файла» (ENFILE-семейство; узнаваемо и у не-Error исходов stub'а). */
function isEnoent(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** Строгая сверка планов (§9): совпасть должны и состав, и порядок (порядок — порядок удаления). */
function sameFiles(a: readonly WipeFileRecord[], b: readonly WipeFileRecord[]): boolean {
  return (
    a.length === b.length &&
    a.every((file, index) => file.path === b[index]?.path && file.category === b[index]?.category)
  );
}

/** Ошибка wipe без чувствительных деталей: причина — в cause (память main, §14). */
function errWipe(
  reason: 'execute-without-plan' | 'plan-outdated',
  details?: { planned: string[]; current: string[] },
): AppError {
  return AppError.of(
    'WIPE/FAILED',
    WIPE_FAILED_MESSAGE_KEY,
    undefined,
    details === undefined ? { reason } : { reason, ...details },
  );
}

/** COUNT измерений удаляемой БД (§7); таблицы ещё нет — 0 (прецедент 070/071). */
function countMeasurements(db: BackupDatabase): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM bp_measurement').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}
