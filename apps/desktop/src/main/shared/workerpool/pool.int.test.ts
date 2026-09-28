/**
 * TASK-066 §19/§20: интеграционные тесты пула на РЕАЛЬНЫХ worker_threads (vitest,
 * node-окружение). Воркер грузится из исходника worker.ts: тестовый Node
 * (v24, type-stripping по умолчанию) исполняет .ts напрямую — см. шапку worker.ts;
 * задачи — из __fixtures__/workerpool-tasks.mjs (контракт tasksModule).
 *
 * Матрица §19: очередь 3 задачи / 2 воркера (FIFO), распределение параллельных
 * (две sleep-задачи завершаются ~одновременно), краш-задача (process.exit в
 * воркере) → job отклонён, следующая обслуживается, очередь не теряется;
 * прогресс-события доставлены. Плюс §13: отказ задачи не валит пул; §5: таймаут,
 * кооперативная отмена; §9/AC4 (пул): terminate отклоняет активные и ожидающие job.
 */
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';

import { WorkerPool, type WorkerPoolOptions } from './pool.js';
import { TaskError } from './protocol.js';

/** URL исходника воркера: тестовый Node исполняет .ts напрямую (type-stripping). */
const WORKER_ENTRY_URL = new URL('./worker.ts', import.meta.url);
/** Тестовые задачи (plain .mjs — единственный файл, воркер импортирует динамически). */
const TASKS_MODULE_URL = new URL('./__fixtures__/workerpool-tasks.mjs', import.meta.url);

/** Все созданные пулы — terminate в afterAll (не оставлять потоки после тестов). */
const pools: WorkerPool[] = [];

/** Фабрика пула под тесты: боевой worker.ts + тестовый модуль задач. */
function newPool(options: WorkerPoolOptions = {}): WorkerPool {
  const pool = new WorkerPool({
    entryUrl: WORKER_ENTRY_URL,
    tasksModule: TASKS_MODULE_URL.href,
    ...options,
  });
  pools.push(pool);
  return pool;
}

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.terminate()));
});

describe('WorkerPool — круговой обмен и отказ задачи (§13/§19)', () => {
  it('run: результат задачи возвращается; неизвестное имя — отказ только этой job', async () => {
    const pool = newPool();

    await expect(pool.run('greet', { name: 'vitest' })).resolves.toEqual({
      greeting: 'hello vitest',
    });
    // §13 fail-fast: отклоняется конкретный promise, пул продолжает работу.
    await expect(pool.run('unknown-task', {})).rejects.toThrow(/unknown task/);
    await expect(pool.run('greet', { name: 'снова' })).resolves.toEqual({
      greeting: 'hello снова',
    });
  });

  it('ошибка задачи — TaskError, пул живой, следующая задача обслуживается', async () => {
    const pool = newPool();

    const failure = pool.run('fail', {});
    await expect(failure).rejects.toBeInstanceOf(TaskError);
    await expect(failure).rejects.toThrow(/task failed/);

    await expect(pool.run('greet', { name: 'после отказа' })).resolves.toEqual({
      greeting: 'hello после отказа',
    });
  });
});

describe('WorkerPool — распределение и FIFO (§19: 2 воркера)', () => {
  it('две sleep-задачи завершаются ~одновременно (параллельное распределение)', async () => {
    const pool = newPool();
    const startedAtMs = performance.now();

    await Promise.all([pool.run('sleep', { ms: 250 }), pool.run('sleep', { ms: 250 })]);

    const elapsedMs = performance.now() - startedAtMs;
    // Серийно на одном воркере было бы ≥500 мс; на двух — около 250 мс (запас на
    // планировщик: тест ловит «два потока», а не точное время).
    expect(elapsedMs).toBeLessThan(450);
  });

  it('3 задачи на 2 воркерах: третья стартует только после освобождения воркера (FIFO §13)', async () => {
    const pool = newPool();
    const startedAtMs: Array<{ label: string; atMs: number }> = [];
    const endedAtMs: number[] = [];
    const job = (label: string, ms: number): Promise<unknown> =>
      pool.run(
        'sleepProgress',
        { ms },
        {
          onProgress: (progress) => {
            if (progress === 0) {
              startedAtMs.push({ label, atMs: performance.now() });
            }
          },
        },
      );

    const first = job('t1', 150);
    const second = job('t2', 150);
    const third = job('t3', 100);
    void first.then(() => endedAtMs.push(performance.now()));
    void second.then(() => endedAtMs.push(performance.now()));
    void third.then(() => endedAtMs.push(performance.now()));
    await Promise.all([first, second, third]);

    const atOf = (label: string): number => {
      const found = startedAtMs.find((entry) => entry.label === label);
      expect(found, `старт ${label} доставлен через onProgress`).toBeDefined();
      return found?.atMs ?? 0;
    };
    // t2 стартовал, пока t1 работал — задействованы оба воркера.
    expect(atOf('t2')).toBeLessThan(atOf('t1') + 135);
    // t3 стартовал не раньше, чем освободился первый воркер (FIFO §13: очередь).
    expect(atOf('t3')).toBeGreaterThanOrEqual(Math.min(...endedAtMs) - 15);
  });
});

describe('WorkerPool — устойчивость (§19/§20 AC2)', () => {
  it(
    'краш воркера: job отклонён, очередь не потеряна, перезапущенный воркер обслуживает',
    { timeout: 15_000 },
    async () => {
      const pool = newPool();
      const crashed = pool.run('crash', {});
      const busy = pool.run('sleepProgress', { ms: 200 });
      const queued = pool.run('greet', { name: 'из очереди' });

      await expect(crashed).rejects.toThrow(/worker crashed/);
      // Остальные job не потеряны: вторая воркер доводит, третья уходит в очередь и
      // обслуживается (перезапущенным или уцелевшим воркером — §13).
      await expect(busy).resolves.toEqual({ sleptMs: 200 });
      await expect(queued).resolves.toEqual({ greeting: 'hello из очереди' });
      // Пул живой после краша: новая задача выполняется.
      await expect(pool.run('greet', { name: 'снова' })).resolves.toEqual({
        greeting: 'hello снова',
      });
    },
  );

  it(
    'таймаут: job отклонена, воркер перезапущен, следующая задача обслуживается (§5/§22)',
    { timeout: 15_000 },
    async () => {
      const pool = newPool();

      await expect(pool.run('sleep', { ms: 800 }, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
      await expect(pool.run('greet', { name: 'после таймаута' })).resolves.toEqual({
        greeting: 'hello после таймаута',
      });
    },
  );

  it('кооперативная отмена: abort-сигнал доставлен задаче, воркер не крашится (§5)', async () => {
    const pool = newPool();
    const controller = new AbortController();
    const job = pool.run('abortable', {}, { signal: controller.signal });

    setTimeout(() => controller.abort(), 50);

    await expect(job).rejects.toThrow(/aborted/);
    await expect(pool.run('greet', { name: 'после отмены' })).resolves.toEqual({
      greeting: 'hello после отмены',
    });
  });
});

describe('WorkerPool — прогресс и завершение', () => {
  it('прогресс-события 0..1 доставлены подписчику по порядку (§20 AC5)', async () => {
    const pool = newPool();
    const progressEvents: number[] = [];

    const result = await pool.run('progress', {}, { onProgress: (p) => progressEvents.push(p) });

    expect(result).toBe('done');
    expect(progressEvents).toEqual([0, 0.5, 1]);
  });

  it(
    'terminate: активные и ожидающие job отклонены, run после terminate отказывает, идемпотентен (AC4)',
    { timeout: 15_000 },
    async () => {
      const pool = newPool();
      const active1 = pool.run('sleepProgress', { ms: 500 });
      const active2 = pool.run('sleepProgress', { ms: 500 });
      const queued = pool.run('greet', { name: 'брошенная' });
      await new Promise((resolve) => setTimeout(resolve, 50)); // распределение: 2 активных, 1 в очереди

      const termination = pool.terminate();
      await expect(active1).rejects.toThrow(/terminated/);
      await expect(active2).rejects.toThrow(/terminated/);
      await expect(queued).rejects.toThrow(/terminated/);
      await termination; // shutdown не висит (§9)

      await expect(pool.run('greet', { name: 'позже' })).rejects.toThrow(/terminated/);
      await expect(pool.terminate()).resolves.toBeUndefined(); // идемпотентность
    },
  );
});
