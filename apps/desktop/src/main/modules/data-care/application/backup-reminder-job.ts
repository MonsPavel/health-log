/**
 * TASK-074 §5: задача `backup.reminder` — первая задача JobScheduler. Условие
 * (таблица §13): последняя копия старше 14 дней ИЛИ отсутствует при ≥7 записях —
 * задача возвращает действие `{show: {kind: 'backup-reminder'}}`; иначе null.
 * Решение о показе (дедупликация ≤1/7д, lastShown) принимает scheduler (§7) —
 * здесь только УСЛОВИЕ.
 *
 * Метаданные копии (§5): `prefs.jobState.lastBackup` {path, at} — обновляется
 * при успехе канала backup/create («TASK-073 onSuccess»: обёртка хендлера в
 * container.ts через чистую функцию jobStateWithBackup ниже).
 *
 * Порог «≥7 записей» (§13): меньшего дневника не теряем — мягкость (FR-4.4-стиль,
 * не пугаем новичка). Граница 14 дней (§20 AC5): баннер молчит, пока 14 дней
 * НЕ истекли (now − at < 14д); на истечении (≥14д) — напоминание разрешено.
 *
 * Живых таймеров нет (§5): runOnStart — проверка при каждом старте (§4 семантика
 * scheduler'а); частота показа ограничена дедупликацией scheduler'а (1/7д).
 */
import type { JobState } from '@hl/contracts';

import type { JobCtx, JobDefinition, JobShowAction } from '../../../shared/scheduler/scheduler.js';

/** Имя задачи в реестре scheduler'а и ключ lastRun в prefs.jobState.jobs (§5). */
export const BACKUP_REMINDER_JOB_NAME = 'backup.reminder';

/** kind действия/события/дедупликации (§7/§11; ключ в jobState.shown). */
export const BACKUP_REMINDER_KIND = 'backup-reminder';

/** Возраст копии, с которого дневник считается «без свежей копии» (§13: 14 дней). */
export const BACKUP_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Число записей, при отсутствии копии у которого пора напомнить (§13). */
export const MIN_ENTRIES_WITHOUT_BACKUP = 7;

/** Действие «показать подсказку о копии» (§7). */
const SHOW_REMINDER: JobShowAction = { show: { kind: BACKUP_REMINDER_KIND } };

/** Зависимости задачи (§7): счётчик записей дневника — порт (БД не нужна). */
export interface BackupReminderJobDeps {
  /** Число всех записей журнала (COUNT; боевой — measurementRepo.countByPeriod). */
  readonly countMeasurements: () => Promise<number>;
}

/**
 * Фабрика задачи (§5): name = backup.reminder, runOnStart — условие проверяется
 * при каждом старте (§4); intervalMs нет — живые таймеры вне MVP (§5 «не включено»).
 */
export function createBackupReminderJob(deps: BackupReminderJobDeps): JobDefinition {
  return {
    name: BACKUP_REMINDER_JOB_NAME,
    runOnStart: true,
    run: async (ctx: JobCtx): Promise<JobShowAction | null> => {
      const count = await deps.countMeasurements();
      const lastBackupAt = ctx.prefs.jobState.lastBackup?.at;

      // Копии нет вовсе (§13): напоминаем только при достаточном дневнике —
      // «нечего терять» у новичка, не пугаем.
      if (lastBackupAt === undefined) {
        return count >= MIN_ENTRIES_WITHOUT_BACKUP ? SHOW_REMINDER : null;
      }
      // Копия есть (§13): тишина, пока 14 дней не истекли (§20 AC5).
      return ctx.now.utcMs - lastBackupAt >= BACKUP_STALE_MS ? SHOW_REMINDER : null;
    },
  };
}

/**
 * Чистая функция обновления jobState после успешного создания копии (§5 «onSuccess»):
 * пишет метаданные {path, at} поверх текущего состояния, jobs/shown сохраняет —
 * дедупликация показа и lastRun задач не сбиваются записью копии. Иммутабельно.
 */
export function jobStateWithBackup(jobState: JobState, path: string, atUtcMs: number): JobState {
  return { ...jobState, lastBackup: { path, at: atUtcMs } };
}
