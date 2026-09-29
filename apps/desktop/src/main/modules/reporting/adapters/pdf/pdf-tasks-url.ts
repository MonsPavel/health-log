/**
 * TASK-067 §9: file URL модуля задач reporting для дефолта пула в контейнере
 * (TASK-066: «потребитель 067 передаст свой собранный модуль»).
 *
 * Файл — НАМЕРЕННО лёгкий (без импортов цепочки react-pdf): его импортирует
 * container.ts, и тяжёлый воркер-стек не должен попадать в граф main-процесса
 * (§7: рендер — в воркере).
 *
 * РЕЗОЛВИНГ: рядом с этим модулем лежит либо собранный pdf-tasks.js (прод/дев —
 * код исполняется из dist), либо только исходник pdf-tasks.ts (vitest на свежем
 * checkout — код исполняется нативным type-stripping Node). Выбор по факту
 * наличия файла: собранный выигрывает; отсутствие обоих — честный отказ воркера
 * при импорте (краш потока → перезапуск с логом, TASK-066 §13).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Собранный модуль (прод-раскладка dist/main). */
const COMPILED_URL = new URL('./pdf-tasks.js', import.meta.url);
/** Исходник для тестового рантайма (нативный Node type-stripping). */
const SOURCE_URL = new URL('./pdf-tasks.ts', import.meta.url);

/** URL модуля задач reporting (дефолт WorkerPoolOptions.tasksModule в контейнере). */
export const PDF_TASKS_MODULE_URL: URL = existsSync(fileURLToPath(COMPILED_URL))
  ? COMPILED_URL
  : SOURCE_URL;
