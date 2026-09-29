/**
 * TASK-074 §5: минимальный JobScheduler — реестр задач `register({name, runOnStart?,
 * intervalMs?, run(ctx)})` и `tick(now)`: запуск задач с истёкшим интервалом.
 *
 * ЖИВЫХ ТАЙМЕРОВ НЕТ (§5 «не включено»): в MVP tick вызывается один раз при старте
 * приложения (container.ts), то есть семантика runOnStart — «при каждом старте
 * проверь условие» (§4): задача с runOnStart выполняется при каждом tick, а
 * дедупликация ПОКАЗА (shown, 7 дней) ограничивает частоту эффекта. intervalMs —
 * для будущих живых задач (FR-10, пост-MVP §23): повтор при
 * now − lastRun ≥ intervalMs (первый запуск — сразу). Комбинация runOnStart +
 * intervalMs ведёт себя как runOnStart (проверка на каждом старте).
 *
 * СОСТОЯНИЕ (§5/§12): lastRun — `prefs.jobState.jobs[name]`, lastShown —
 * `prefs.jobState.shown[kind]`; хранение персистентное — prefs через порт store
 * (боевой — PreferencesService, structural port ниже). Одна запись setPrefs на tick
 * с накопленным jobState (§15: tick — микросекунды, запись одна).
 *
 * РЕШЕНИЕ О ПОКАЗЕ (§7): задача ВОЗВРАЩАЕТ действие (`{show: {kind}}`) или null;
 * показывать ли — решает scheduler: не чаще SHOW_DEDUP_INTERVAL_MS (раз в неделю,
 * §13) на kind. Доставку и прикладной лог делает sink (контейнер: событие
 * `job:backup-reminder` renderer-у + лог §18 `job backup-reminder shown/snoozed`).
 *
 * ИЗОЛЯЦИЯ ОШИБОК (§9/§20 AC1): падение run() одной задачи логируется и не мешает
 * остальным; lastRun упавшей задачи НЕ пишется — задача повторится на следующем
 * tick. Отказ store (prefs) не ловится намеренно: вызывающий (container) решает,
 * критичен ли сбой состояния планировщика на старте.
 */
import type { Prefs, PrefsPatch } from '@hl/contracts';
import type { Instant } from '@hl/kernel';

/** Окно дедупликации показа (§5/§13: подсказка о копии — не чаще раза в неделю). */
export const SHOW_DEDUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Действие задачи (§7): попросить показ напоминания вида kind. */
export interface JobShowAction {
  readonly show: { readonly kind: string };
}

/** Контекст выполнения задачи (§7). */
export interface JobCtx {
  /** Полный документ prefs на момент tick (условия задач читают здесь). */
  readonly prefs: Prefs;
  /** Момент tick (UTC мс + пояс устройства; FixedClock в тестах, NFR-10). */
  readonly now: Instant;
}

/** Определение задачи (§5). run возвращает действие или null (действий нет). */
export interface JobDefinition {
  /** Уникальное имя — ключ lastRun в jobState.jobs. */
  readonly name: string;
  /** Проверять условие при каждом старте (каждом tick) — §4. */
  readonly runOnStart?: boolean;
  /** Интервал повтора, мс (без runOnStart; живые таймеры — FR-10, §23). */
  readonly intervalMs?: number;
  /** Тело задачи; падение изолируется (§9), наружу — только действие. */
  readonly run: (ctx: JobCtx) => JobShowAction | null | Promise<JobShowAction | null>;
}

/** Порт prefs (§12; структурно удовлетворяет PreferencesService — прецедент минимальных поверхностей). */
export interface JobPrefsStore {
  getPrefs(): Promise<Prefs>;
  setPrefs(patch: PrefsPatch): Promise<Prefs>;
}

/** Порт доставки решения о показе (§11/§18): событие renderer-у + лог — контейнер. */
export interface JobShowSink {
  /** kind допущен к показу (прошёл окно дедупликации). */
  show(kind: string): void;
  /** kind был должен показаться, но подавлен окном дедупликации (пауза «Позже»). */
  snooze(kind: string): void;
}

/** Минимальная поверхность логгера (§18; HlLogger ей удовлетворяет). */
export interface JobSchedulerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости планировщика (§7): подстановочные в тестах (§19). */
export interface JobSchedulerDeps {
  readonly store: JobPrefsStore;
  readonly sink: JobShowSink;
  readonly logger: JobSchedulerLogger;
}

/** Реестр задач и запуск по tick (§5). Один экземпляр на приложение (container). */
export class JobScheduler {
  private readonly jobs = new Map<string, JobDefinition>();

  constructor(private readonly deps: JobSchedulerDeps) {}

  /** Регистрирует задачу; повторная регистрация того же имени заменяет определение. */
  register(definition: JobDefinition): void {
    this.jobs.set(definition.name, definition);
  }

  /**
   * Запускает задачи, чей момент наступил (§5). Порядок — регистрации (Map);
   * задачи независимы: падение одной не прерывает остальных (§9). Изменения
   * jobState накапливаются и пишутся ОДНОЙ записью в конце tick.
   */
  async tick(now: Instant): Promise<void> {
    const prefs = await this.deps.store.getPrefs();
    let jobState = prefs.jobState;
    let changed = false;

    for (const job of this.jobs.values()) {
      if (!this.isDue(job, jobState.jobs[job.name], now.utcMs)) {
        continue;
      }
      try {
        const action = await job.run({ prefs, now });
        // lastRun — после УСПЕШНОГО выполнения: упавшая задача повторится (§9).
        jobState = { ...jobState, jobs: { ...jobState.jobs, [job.name]: now.utcMs } };
        changed = true;
        const kind = action === null ? undefined : action.show.kind;
        if (kind !== undefined) {
          const lastShownAt = jobState.shown[kind];
          if (lastShownAt !== undefined && now.utcMs - lastShownAt < SHOW_DEDUP_INTERVAL_MS) {
            this.deps.sink.snooze(kind);
          } else {
            jobState = { ...jobState, shown: { ...jobState.shown, [kind]: now.utcMs } };
            this.deps.sink.show(kind);
          }
        }
      } catch (cause) {
        this.deps.logger.error('scheduler: задача упала — остальные продолжаются', {
          job: job.name,
          cause,
        });
      }
    }

    if (changed) {
      await this.deps.store.setPrefs({ jobState });
    }
  }

  /**
   * Наступил ли момент задачи (§5): runOnStart — при каждом tick («при каждом
   * старте проверь условие», §4); interval-задача — если ещё не ran или интервал
   * истёк (точность на границе: now − lastRun ≥ intervalMs); без флагов —
   * единственный первый запуск (программная конфигурация «запуститься один раз»).
   */
  private isDue(job: JobDefinition, lastRunAt: number | undefined, nowMs: number): boolean {
    if (job.runOnStart === true) {
      return true;
    }
    if (job.intervalMs !== undefined) {
      return lastRunAt === undefined || nowMs - lastRunAt >= job.intervalMs;
    }
    return lastRunAt === undefined;
  }
}
