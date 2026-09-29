/**
 * TASK-074 §13/§19/§20: тесты задачи backup.reminder — точное поведение по таблице §13.
 *
 * Матрица:
 *  - копии нет + записей < 7      → null (не напоминаем — «нечего терять», правило §13);
 *  - копии нет + записей ≥ 7      → show (баннер);
 *  - копия свежая (< 14 дней)     → null (тишина);
 *  - копия ровно 14 дней          → show (AC5: «не возвращается ДО истечения 14 дней»);
 *  - копия старше 14 дней         → show;
 *  - после создания копии (jobStateWithBackup): серия ежедневных проверок — тишина
 *    до истечения 14 дней, на 14-й день баннер разрешён (§20 AC5).
 *
 * Weekly-дедуп (≤1/7д) — ответственность scheduler'а (§7), здесь не тестируется.
 * Время — FixedClock (NFR-10); счётчик записей — подстановка (порт), БД не нужна.
 */
import { describe, expect, it } from 'vitest';

import { PREFS_SCHEMA, type Prefs } from '@hl/contracts';
import { FixedClock, type Instant } from '@hl/kernel';

import {
  BACKUP_REMINDER_JOB_NAME,
  createBackupReminderJob,
  jobStateWithBackup,
} from './backup-reminder-job.js';

const DAY_MS = 86_400_000;
const T0 = 1_700_000_000_000;

/** Момент проверки: Instant из FixedClock (§5: тесты на фиктивных часах). */
function nowAt(clock: FixedClock): Instant {
  return { utcMs: clock.nowMs(), tzOffsetMin: clock.tzOffsetMin() };
}

function prefsWith(jobState: Prefs['jobState']): Prefs {
  return { ...PREFS_SCHEMA.parse({}), jobState };
}

/** Задача с подставным счётчиком записей; возвращает действие run(). */
function runJob(options: {
  prefs: Prefs;
  now: Instant;
  count: number;
}): Awaited<ReturnType<ReturnType<typeof createBackupReminderJob>['run']>> {
  const job = createBackupReminderJob({ countMeasurements: async () => options.count });
  return job.run({ prefs: options.prefs, now: options.now });
}

describe('backup.reminder — таблица §13', () => {
  it('копии нет, записей 6 (< 7) → тишина: напоминаем, только когда есть что терять', async () => {
    const result = await runJob({
      prefs: prefsWith(PREFS_SCHEMA.parse({}).jobState),
      now: nowAt(new FixedClock(T0, 180)),
      count: 6,
    });
    expect(result).toBeNull();
  });

  it('копии нет, записей ровно 7 → show (порог: ≥7 записей без единой копии)', async () => {
    const result = await runJob({
      prefs: prefsWith(PREFS_SCHEMA.parse({}).jobState),
      now: nowAt(new FixedClock(T0, 180)),
      count: 7,
    });
    expect(result).toEqual({ show: { kind: 'backup-reminder' } });
  });

  it('копия свежая (14 дней минус 1 мс) → тишина', async () => {
    const result = await runJob({
      prefs: prefsWith(jobStateWithBackup(PREFS_SCHEMA.parse({}).jobState, 'b.hlbackup', T0)),
      now: nowAt(new FixedClock(T0 + 14 * DAY_MS - 1, 180)),
      count: 50,
    });
    expect(result).toBeNull();
  });

  it('копия ровно 14 дней → show (14 дней истекли — AC5)', async () => {
    const result = await runJob({
      prefs: prefsWith(jobStateWithBackup(PREFS_SCHEMA.parse({}).jobState, 'b.hlbackup', T0)),
      now: nowAt(new FixedClock(T0 + 14 * DAY_MS, 180)),
      count: 50,
    });
    expect(result).toEqual({ show: { kind: 'backup-reminder' } });
  });

  it('копия старше 14 дней → show', async () => {
    const result = await runJob({
      prefs: prefsWith(jobStateWithBackup(PREFS_SCHEMA.parse({}).jobState, 'b.hlbackup', T0)),
      now: nowAt(new FixedClock(T0 + 14 * DAY_MS + 1, 180)),
      count: 50,
    });
    expect(result).toEqual({ show: { kind: 'backup-reminder' } });
  });
});

describe('backup.reminder — после создания копии баннер не возвращается (§20 AC5)', () => {
  it('ежедневные проверки 14 дней после копии — тишина; на 14-й день — show', async () => {
    const base = PREFS_SCHEMA.parse({}).jobState;
    const prefs = prefsWith(jobStateWithBackup(base, 'fresh.hlbackup', T0));

    const job = createBackupReminderJob({ countMeasurements: async () => 20 });

    for (let day = 1; day < 14; day += 1) {
      const action = await job.run({ prefs, now: nowAt(new FixedClock(T0 + day * DAY_MS, 180)) });
      expect(action).toBeNull();
    }
    const onExpiry = await job.run({
      prefs,
      now: nowAt(new FixedClock(T0 + 14 * DAY_MS, 180)),
    });
    expect(onExpiry).toEqual({ show: { kind: 'backup-reminder' } });
  });
});

describe('backup.reminder — определение и метаданные (§5)', () => {
  it('имя backup.reminder, runOnStart (проверка при каждом старте, §4)', () => {
    const job = createBackupReminderJob({ countMeasurements: async () => 0 });
    expect(job.name).toBe(BACKUP_REMINDER_JOB_NAME);
    expect(BACKUP_REMINDER_JOB_NAME).toBe('backup.reminder');
    expect(job.runOnStart).toBe(true);
  });

  it('jobStateWithBackup — чистая функция: пишет lastBackup {path, at}, сохраняет jobs/shown', () => {
    const base = {
      jobs: { 'backup.reminder': T0 },
      shown: { 'backup-reminder': T0 },
    };
    const next = jobStateWithBackup(base, String.raw`D:\copy.hlbackup`, T0 + 5);

    expect(next.lastBackup).toEqual({ path: String.raw`D:\copy.hlbackup`, at: T0 + 5 });
    expect(next.jobs).toEqual({ 'backup.reminder': T0 });
    expect(next.shown).toEqual({ 'backup-reminder': T0 });
    expect(base.lastBackup).toBeUndefined(); // исходный объект не мутируется
  });
});
