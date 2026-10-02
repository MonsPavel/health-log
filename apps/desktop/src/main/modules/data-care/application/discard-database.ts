/**
 * TASK-101 §5/§8/§9/§13: use case DiscardDatabase — «начать заново» на
 * recovery-экране: удалить ТОЛЬКО файлы повреждённой БД (db/-wal/-shm) и
 * перезапустить приложение — после двойного подтверждения UI (диалог + чекбокс-
 * фраза, §13: необратимость честная — данные не читаются, но файлы удаляются).
 *
 * ПОДМНОЖЕСТВО WIPE (§9 «data/wipe-execute-подмножество»): в отличие от полного
 * удаления (TASK-072) НЕ трогаются ключ хранилища (vault.key — парольная сессия
 * пользователя сохраняется), каталог копий и логи (EC-14: копии — страховка
 * пользователя, §8 «повреждённый файл НЕ удаляется автоматически при
 * „Восстановить“ — только при „Начать заново“»). Авто-страховки НЕТ по определению:
 * удаляются повреждённые файлы, восстановить которые нельзя (§13).
 *
 * ПОРЯДОК execute (§8, прецедент wipe-all 072):
 *  1. closeCurrentDb (checkpoint+close — точка контейнера; в recovery соединение
 *     уже закрыто — безопасный close контейнера no-op);
 *  2. unlink db → -wal → -shm (основной файл последним — частичный сбой оставляет
 *     читаемое состояние; отсутствующие файлы — не сбой: SQLite чистит -wal/-shm
 *     при закрытии);
 *  3. успех → relaunch (отложенный — деталь контейнера, прецедент 071/072); частичный
 *     сбой unlink → отказ БЕЗ перезапуска (полуживое состояние хуже — пользователь
 *     видит ошибку, §9 072).
 *
 * Ошибки (§5): наружу только AppError значением Result — WIPE/FAILED (тот же код
 * домена Data Care; детали — remaining в cause, память main, §14).
 *
 * Безопасность (§14): путь БД — параметр контейнера (renderer пути не шлёт); лог —
 * по basename (без полных путей). Лог (§18): `recovery discard execute` →
 * `recovery file deleted` на каждый unlink → `recovery discard success`.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError, type Result } from '@hl/kernel';

import { WIPE_FAILED_MESSAGE_KEY } from './wipe-all.js';
import type { FileOpQueue } from './file-op-queue.js';

/** Минимальная поверхность логгера use case (§18; прецедент WipeAllDataLogger). */
export interface DiscardDatabaseLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости use case (§19: подстановочные в тестах). */
export interface DiscardDatabaseDeps {
  /** Путь файла повреждённой БД (-wal/-shm выводятся конвенцией SQLite, §8). */
  readonly dbPath: string;
  /**
   * Закрытие текущего соединения (checkpoint+close — точка контейнера, §8).
   * Боевой — безопасный close контейнера (lockCloseDatabase): в recovery соединение
   * уже закрыто — no-op.
   */
  readonly closeCurrentDb: () => void;
  /** Логгер (§18) — категория db. */
  readonly logger: DiscardDatabaseLogger;
  /** Очередь файловых операций (§9 070 — сериализация с копиями/экспортами). */
  readonly queue: FileOpQueue;
  /** Планировщик перезапуска (§9; боевой — отложенный relaunch, прецедент 071/072). */
  readonly relaunch: () => void;
  /**
   * Точка мок-сбоя тестов (§19, прецедент unlink-порта 072): детерминированный
   * EPERM-stub вместо физической защиты файлов. По умолчанию — реальный unlinkSync.
   */
  readonly unlink?: (path: string) => void;
}

/** Значение результата: факт запланированного перезапуска (§11). */
export interface DiscardDatabaseResultValue {
  readonly restarting: true;
}

/**
 * Use case «начать заново» (TASK-101 §5). Один экземпляр на приложение (контейнер;
 * канал `data/discard-db` регистрируется только в recovery-режиме).
 */
export class DiscardDatabaseUseCase {
  constructor(private readonly deps: DiscardDatabaseDeps) {}

  /** Выполняет удаление (§8); ошибки — значением Result, исключения не пересекают слои. */
  async execute(): Promise<Result<DiscardDatabaseResultValue, AppError>> {
    // Файловая операция — строго под FileOpQueue (§9 070); тело синхронное (unlink).
    return this.deps.queue.run(() => Promise.resolve(this.runDiscard()));
  }

  /** Тело операции (§8): close → unlink db/-wal/-shm → relaunch. */
  private runDiscard(): Result<DiscardDatabaseResultValue, AppError> {
    const startedAtMs = performance.now();
    this.deps.logger.info('recovery discard execute', {});

    // 1. Закрытие БД (§8): сбой закрытия → отказ без удаления (прецедент 072 §9).
    try {
      this.deps.closeCurrentDb();
    } catch (error) {
      this.deps.logger.error('recovery discard: сбой закрытия БД (ничего не удалено)', {
        code: 'WIPE/FAILED',
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return {
        ok: false,
        error: AppError.of('WIPE/FAILED', WIPE_FAILED_MESSAGE_KEY, undefined, error),
      };
    }

    // 2. Unlink (§8): основной файл ПОСЛЕДНИМ (-wal → -shm → db — прецедент порядка 072).
    const unlink = this.deps.unlink ?? unlinkSync;
    for (const suffix of ['-wal', '-shm', '']) {
      const path = `${this.deps.dbPath}${suffix}`;
      if (!existsSync(path)) {
        // Отсутствующие файлы — не сбой (§9 072: цель — отсутствие — достигнута).
        this.deps.logger.debug('recovery file already absent', { file: basename(path) });
        continue;
      }
      try {
        unlink(path);
      } catch (error) {
        // Частичный сбой (§9): что осталось — в cause (память main), без перезапуска.
        this.deps.logger.error('recovery discard: частичный сбой удаления', {
          code: 'WIPE/FAILED',
          file: basename(path),
          durationMs: Math.round(performance.now() - startedAtMs),
        });
        return {
          ok: false,
          error: AppError.of('WIPE/FAILED', WIPE_FAILED_MESSAGE_KEY, undefined, {
            reason: 'partial-unlink',
            failed: basename(path),
            cause: error,
          }),
        };
      }
      this.deps.logger.info('recovery file deleted', { file: basename(path) });
    }

    // 3. Успех (§5/§9): перезапуск запланирован — приложение стартует с пустой БД.
    this.deps.logger.info('recovery discard success', {
      durationMs: Math.round(performance.now() - startedAtMs),
    });
    this.deps.relaunch();
    return { ok: true, value: { restarting: true } };
  }
}
