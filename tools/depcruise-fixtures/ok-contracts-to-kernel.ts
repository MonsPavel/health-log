/**
 * Фикстура TASK-005 §19: чистый кейс — направление contracts→kernel разрешено
 * (арх. 03 §4: contracts зависит от kernel). Ожидание — ноль нарушений.
 *
 * Импорт ведёт в реальный исходник packages/kernel/src (не в dist), чтобы правило
 * packages-layering проверялось на честном ребре графа, а не на неразрешённом имени.
 * В основном прогоне `pnpm depcruise` исключается через .dependency-cruiser-ignore.
 */
import * as kernel from '../../../packages/kernel/src/index.js';

export const contractsToKernel = kernel;
