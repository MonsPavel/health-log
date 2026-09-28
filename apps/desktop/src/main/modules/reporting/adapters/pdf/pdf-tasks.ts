/**
 * TASK-067 §5/§9: модуль задач reporting для воркера пула (контракт TasksModule
 * TASK-066 worker.ts: единственный экспорт registerTasks({registerTask})).
 *
 * Пул грузит этот модуль динамическим импортом по workerData.tasksModule:
 *  - прод/дев: собранный pdf-tasks.js из dist (URL даёт pdf-tasks-url.ts,
 *    контейнер подставляет его дефолтом);
 *  - тесты: этот же файл из src — нативный Node type-stripping (прецедент
 *    ограничений worker.ts TASK-066), поэтому runtime-импорты внутри цепочки
 *    — с '.ts'-спесификаторами (tsc переписывает в '.js' на emit —
 *    rewriteRelativeImportExtensions).
 */
import type { TaskHandler } from '../../../shared/workerpool/protocol.js';

import { registerPdfTask } from './pdf-task.ts';

/** Контракт TasksModule (worker.ts TASK-066) — форма, читает worker.ts. */
export interface ReportingTasksModule {
  registerTasks(api: { registerTask: (name: string, handler: TaskHandler) => void }): void;
}

export function registerTasks(api: Parameters<ReportingTasksModule['registerTasks']>[0]): void {
  registerPdfTask(api);
}
