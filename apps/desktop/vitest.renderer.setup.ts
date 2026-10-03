/**
 * TASK-105 §20 (урок прогона 3 живой приёмки): калибровка Testing Library для
 * jsdom-проекта рендерера. Дефолтная 1 с findBy* не выдерживает первые
 * монтирования App на windows-runner (4 vCPU): под полной загрузкой пула
 * (103 jsdom-окружения, ~49 с суммарного создания) router.test.ts ловил
 * «Загрузка…» вместо #/ai и #/settings — элементы появляются, но позже.
 * 3 с — только ожидание findBy (семантика ассертов «элемент появляется» не
 * меняется, wall-clock ассертов на этих путях нет — TASK-085 в vitest.shared.ts
 * о соседней проблеме и её решении fileParallelism: false).
 */
import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: 3_000 });
