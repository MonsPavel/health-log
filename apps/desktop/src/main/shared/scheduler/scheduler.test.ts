/**
 * TASK-074 §19/§20: юниты JobScheduler на FixedClock.
 *
 * Матрица:
 *  - runOnStart — задача выполняется при КАЖДОМ tick (MVP-семантика §4: tick =
 *    «при каждом старте проверь условие», живых таймеров нет);
 *  - intervalMs — без runOnStart: первый запуск (ещё не ran) и повтор только по
 *    истечении интервала (now − lastRun ≥ intervalMs, точность на границе);
 *  - lastRun — пишется в prefs (jobState.jobs[name], §5/§12);
 *  - изоляция ошибок (§9/§20 AC1): упавшая задача логируется, не пишет lastRun
 *    (повтор на следующем tick), остальные задачи выполняются;
 *  - дедупликация показа (§7/§13): show доставляется ≤1 раза в SHOW_DEDUP_INTERVAL_MS
 *    (7 дней) на kind; серия ЕЖЕДНЕВНЫХ запусков — один показ (§20 AC3); на границе
 *    ровно 7 дней показ разрешён снова («Позже» — пауза 7д точно, §20 AC1);
 *  - контекст задачи (§7): ctx = {prefs, now: Instant} из store и аргумента tick.
 */
import { describe, expect, it, vi } from 'vitest';

import { PREFS_SCHEMA, type Prefs, type PrefsPatch } from '@hl/contracts';
import type { Instant } from '@hl/kernel';

import {
  JobScheduler,
  SHOW_DEDUP_INTERVAL_MS,
  type JobCtx,
  type JobDefinition,
  type JobPrefsStore,
  type JobShowAction,
  type JobShowSink,
} from './scheduler.js';

const DAY_MS = 86_400_000;
const T0 = 1_700_000_000_000;
const SHOW: JobShowAction = { show: { kind: 'backup-reminder' } };

/** Fake prefs-store: мутабельный документ + журнал patch (§19). */
function createStore(initial: Prefs = PREFS_SCHEMA.parse({})): {
  store: JobPrefsStore;
  patches: PrefsPatch[];
} {
  let current = initial;
  const patches: PrefsPatch[] = [];
  return {
    patches,
    store: {
      getPrefs(): Promise<Prefs> {
        return Promise.resolve(current);
      },
      setPrefs(patch: PrefsPatch): Promise<Prefs> {
        patches.push(patch);
        current = patch.jobState === undefined ? current : { ...current, jobState: patch.jobState };
        return Promise.resolve(current);
      },
    },
  };
}

/** Fake sink: журнал решений показа (§7). */
function createSink(): JobShowSink & { shown: string[]; snoozed: string[] } {
  return {
    shown: [],
    snoozed: [],
    show(kind) {
      this.shown.push(kind);
    },
    snooze(kind) {
      this.snoozed.push(kind);
    },
  };
}

/** Logger-spy (§18). */
const logger = { info: vi.fn(), error: vi.fn() };

function makeScheduler(store: JobPrefsStore, sink: JobShowSink): JobScheduler {
  return new JobScheduler({ store, sink, logger });
}

/** Instant «старта» приложения (аргумент tick). */
function instantAt(utcMs: number): Instant {
  return { utcMs, tzOffsetMin: 180 };
}

/** Задача-шпион: журнал вызовов + подстановочная реализация (§19). */
function spyJob(
  name: string,
  options: Omit<JobDefinition, 'name' | 'run'>,
  impl: (ctx: JobCtx) => JobShowAction | null = () => null,
): JobDefinition & { calls: JobCtx[] } {
  const calls: JobCtx[] = [];
  return {
    name,
    ...options,
    calls,
    run: (ctx: JobCtx) => {
      calls.push(ctx);
      return impl(ctx);
    },
  };
}

describe('JobScheduler — runOnStart (§4: при каждом старте проверь условие)', () => {
  it('задача с runOnStart выполняется при каждом tick (tick = старт приложения)', async () => {
    const { store } = createStore();
    const job = spyJob('job.a', { runOnStart: true });
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(job);

    await scheduler.tick(instantAt(T0));
    await scheduler.tick(instantAt(T0 + DAY_MS));

    expect(job.calls).toHaveLength(2);
  });

  it('lastRun пишется в prefs (jobState.jobs[name]) — §5/§12', async () => {
    const { store, patches } = createStore();
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(spyJob('job.a', { runOnStart: true }));

    await scheduler.tick(instantAt(T0));

    expect(patches).toHaveLength(1);
    expect(patches[0]?.jobState?.jobs['job.a']).toBe(T0);
  });

  it('повторный запуск обновляет lastRun на момент tick', async () => {
    const { store, patches } = createStore();
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(spyJob('job.a', { runOnStart: true }));

    await scheduler.tick(instantAt(T0));
    await scheduler.tick(instantAt(T0 + 1));

    expect(patches).toHaveLength(2);
    expect(patches[1]?.jobState?.jobs['job.a']).toBe(T0 + 1);
  });
});

describe('JobScheduler — intervalMs (§5: вызов задач с истёкшим интервалом)', () => {
  it('первый запуск выполняется сразу, повтор — только по истечении интервала', async () => {
    const { store } = createStore();
    const job = spyJob('job.tick', { intervalMs: 100 });
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(job);

    await scheduler.tick(instantAt(T0));
    expect(job.calls).toHaveLength(1);

    await scheduler.tick(instantAt(T0 + 99));
    expect(job.calls).toHaveLength(1);

    await scheduler.tick(instantAt(T0 + 100));
    expect(job.calls).toHaveLength(2);
  });

  it('runOnStart вместе с intervalMs — проверка при каждом старте (§4-семантика MVP)', async () => {
    const { store } = createStore();
    const job = spyJob('job.both', { runOnStart: true, intervalMs: DAY_MS });
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(job);

    await scheduler.tick(instantAt(T0));
    await scheduler.tick(instantAt(T0 + 10));

    expect(job.calls).toHaveLength(2);
  });
});

describe('JobScheduler — изоляция ошибок задач (§9/§20 AC1)', () => {
  it('упавшая задача: лог, другие задачи работают, lastRun упавшей не пишется', async () => {
    const { store, patches } = createStore();
    const failing = spyJob('job.fail', { runOnStart: true }, () => {
      throw new Error('boom');
    });
    const healthy = spyJob('job.ok', { runOnStart: true });
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(failing);
    scheduler.register(healthy);

    await scheduler.tick(instantAt(T0));

    expect(healthy.calls).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
    const patch = patches[0]?.jobState;
    expect(patch?.jobs['job.ok']).toBe(T0);
    expect(patch?.jobs['job.fail']).toBeUndefined();
  });

  it('упавшая задача повторяется на следующем tick (lastRun не писан)', async () => {
    const { store } = createStore();
    const failing = spyJob('job.fail', { intervalMs: 10 }, () => {
      throw new Error('boom');
    });
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(failing);

    await scheduler.tick(instantAt(T0));
    await scheduler.tick(instantAt(T0 + 10));

    expect(failing.calls).toHaveLength(2);
  });
});

describe('JobScheduler — дедупликация показа (§7/§13: не чаще раза в неделю)', () => {
  it('show доставляется в sink, lastShown пишется (jobState.shown[kind])', async () => {
    const { store, patches } = createStore();
    const sink = createSink();
    const scheduler = makeScheduler(store, sink);
    scheduler.register(spyJob('job.a', { runOnStart: true }, () => SHOW));

    await scheduler.tick(instantAt(T0));

    expect(sink.shown).toEqual(['backup-reminder']);
    expect(patches[0]?.jobState?.shown['backup-reminder']).toBe(T0);
  });

  it('пауза 7д точно: через 7 дней минус 1 мс — snooze, ровно 7 дней — показ снова (§20 AC1)', async () => {
    const { store } = createStore();
    const sink = createSink();
    const scheduler = makeScheduler(store, sink);
    scheduler.register(spyJob('job.a', { runOnStart: true }, () => SHOW));

    await scheduler.tick(instantAt(T0));
    await scheduler.tick(instantAt(T0 + SHOW_DEDUP_INTERVAL_MS - 1));
    expect(sink.shown).toEqual(['backup-reminder']);
    expect(sink.snoozed).toEqual(['backup-reminder']);

    await scheduler.tick(instantAt(T0 + SHOW_DEDUP_INTERVAL_MS));
    expect(sink.shown).toEqual(['backup-reminder', 'backup-reminder']);
  });

  it('(§20 AC3) серия ЕЖЕДНЕВНЫХ запусков за неделю — условие проверялось ежедневно, показ ровно один', async () => {
    const { store } = createStore();
    const job = spyJob('job.a', { runOnStart: true }, () => SHOW);
    const sink = createSink();
    const scheduler = makeScheduler(store, sink);
    scheduler.register(job);

    for (let day = 0; day < 7; day += 1) {
      await scheduler.tick(instantAt(T0 + day * DAY_MS));
    }

    expect(job.calls).toHaveLength(7);
    expect(sink.shown).toEqual(['backup-reminder']);
    expect(sink.snoozed).toHaveLength(6);
  });

  it('null-ответ задачи — sink не вызывается', async () => {
    const { store } = createStore();
    const sink = createSink();
    const scheduler = makeScheduler(store, sink);
    scheduler.register(spyJob('job.a', { runOnStart: true }));

    await scheduler.tick(instantAt(T0));

    expect(sink.shown).toEqual([]);
    expect(sink.snoozed).toEqual([]);
  });
});

describe('JobScheduler — контекст задачи (§7: JobCtx {prefs, now})', () => {
  it('run получает prefs из store и now из аргумента tick', async () => {
    const prefs = PREFS_SCHEMA.parse({});
    const { store } = createStore(prefs);
    let seen: JobCtx | undefined;
    const scheduler = makeScheduler(store, createSink());
    scheduler.register({
      name: 'job.a',
      runOnStart: true,
      run: (ctx) => {
        seen = ctx;
        return null;
      },
    });

    await scheduler.tick(instantAt(T0));

    expect(seen?.prefs).toBe(prefs);
    expect(seen?.now).toEqual({ utcMs: T0, tzOffsetMin: 180 });
  });
});

describe('JobScheduler — запись prefs (§12)', () => {
  it('setPrefs вызывается один раз на tick с накопленным jobState (не на каждую задачу)', async () => {
    const { store, patches } = createStore();
    const scheduler = makeScheduler(store, createSink());
    scheduler.register(spyJob('job.a', { runOnStart: true }));
    scheduler.register(spyJob('job.b', { runOnStart: true }));

    await scheduler.tick(instantAt(T0));

    expect(patches).toHaveLength(1);
    expect(patches[0]?.jobState?.jobs).toEqual({ 'job.a': T0, 'job.b': T0 });
  });
});
