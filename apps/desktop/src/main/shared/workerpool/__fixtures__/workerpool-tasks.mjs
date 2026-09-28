/**
 * TASK-066 §19: тестовые задачи реального воркера пула (загружаются динамическим
 * импортом в worker.ts через workerData.tasksModule — контракт см. в worker.ts).
 * Файл — осознанный plain ESM (.mjs): он НЕ компилируется tsc (tsconfig включают
 * только *.ts) и грузится воркером напрямую с диска в тестах, где .ts-воркер
 * работает под нативным type-stripping Node (см. шапку worker.ts).
 *
 * Задачи намеренно мелкие и детерминированные — матрица §19/§20:
 * круговой обмен (greet), сон/распределение (sleep, sleepProgress), CPU-загрузка
 * для замера IPC-ping (burn), краш потока (crash), отказ задачи (fail),
 * прогресс-события (progress), кооперативная отмена (abortable).
 */

/** @returns {Promise<void>} промис, резолвящийся через ms миллисекунд. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Регистрация задач пула — единственная точка входа модуля (вызывает worker.ts).
 *
 * @param {{ registerTask: (name: string, handler: (payload: any, context: unknown) => unknown) => void }} api
 *   API реестра воркера (см. worker.ts).
 */
export function registerTasks(api) {
  api.registerTask('greet', (payload) => ({ greeting: `hello ${payload.name}` }));

  api.registerTask('sleep', async (payload) => {
    await delay(payload.ms);
    return { sleptMs: payload.ms };
  });

  /** Сон с прогресс-событиями «старт» (0) и «финиш» (1) — FIFO/распределение §19. */
  api.registerTask('sleepProgress', async (payload, context) => {
    context.reportProgress(0);
    await delay(payload.ms);
    context.reportProgress(1);
    return { sleptMs: payload.ms };
  });

  /** Чистая загрузка CPU без sleep — замер отзывчивости main (§15/§20 AC3). */
  api.registerTask('burn', (payload) => {
    const deadline = performance.now() + payload.ms;
    while (performance.now() < deadline) {
      // намеренно пустой CPU-цикл: задача должна занимать поток воркера
    }
    return { burnedMs: payload.ms };
  });

  /** Краш потока воркера: exit-событие у пула, job отклоняется (§13/§19). */
  api.registerTask('crash', () => {
    process.exit(7);
  });

  /** Обычный отказ задачи: отклоняется только её promise (§13). */
  api.registerTask('fail', () => {
    throw new Error('task failed');
  });

  /** Прогресс 0..1 тремя событиями (§7/§20 AC5). */
  api.registerTask('progress', async (payload, context) => {
    context.reportProgress(0);
    await delay(30);
    context.reportProgress(0.5);
    await delay(30);
    context.reportProgress(1);
    return 'done';
  });

  /** Кооперативная отмена: цикл завершается по abort-сигналу (§5). */
  api.registerTask('abortable', async (payload, context) => {
    while (!context.signal.aborted) {
      await delay(10);
    }
    return 'aborted';
  });
}
