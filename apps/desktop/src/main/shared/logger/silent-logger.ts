/**
 * TASK-118 §5: молчаливый логгер для тестов — единственная фабрика no-op HlLogger.
 * Заменяет инлайн-литералы `{ debug: () => undefined, … }` в интеграционных тестах:
 * полный HlLogger структурно покрывает узкие логгер-поверхности проекта
 * (ScaleServiceLogger, ExportJsonLogger, депы WorkerPool) — расширение интерфейса
 * больше не ломает частичные стабы. Логгеры-шпионы/собиратели (vi.fn/пуш в массив)
 * несут поведенческую нагрузку и остаются в тестах как были.
 */
import type { HlLogger } from './logger.js';

/** Все шесть методов — no-op: вызов безопасен, вывода нет. */
export function silentLogger(): HlLogger {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  };
}
