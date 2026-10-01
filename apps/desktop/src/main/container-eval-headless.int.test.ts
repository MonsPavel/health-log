/**
 * TASK-092 §4/§5/§20: гард headless-режима eval — env HL_EVAL_HEADLESS=1 в
 * bootstrap НЕ создаёт BrowserWindow (ночной CI-прогон на ubuntu-runner:
 * CPU-инференс без дисплея, xvfb не нужен — eval-режим окна не открывает).
 *
 * Паттерн — те же TEST-ONLY гарды контейнера: fakeLlmEnabled (TASK-078 §14,
 * container-llm-engine.int.test.ts), testModelFileEnabled (TASK-081 §22,
 * container-models.int.test.ts): флаг действует ТОЛЬКО в не-packaged запуске —
 * тест-хук не попадает в продакшн. Bootstrap передаёт результат параметром —
 * сам process.env не читает (§19: тесты без env-мутаций). bootstrap.ts под
 * node не импортируется (статический import electron) — юнит на чистом гарде.
 */
import { describe, expect, it } from 'vitest';

import { evalHeadlessEnabled, HL_EVAL_HEADLESS_ENV } from './container.js';

describe('evalHeadlessEnabled — гард env-флага HL_EVAL_HEADLESS (TASK-092 §4/§5)', () => {
  it('HL_EVAL_HEADLESS=1 в не-packaged запуске — headless включён', () => {
    expect(evalHeadlessEnabled({ [HL_EVAL_HEADLESS_ENV]: '1' }, false)).toBe(true);
  });

  it('packaged игнорирует флаг (§14 — тест-флаг не попадает в продакшн)', () => {
    expect(evalHeadlessEnabled({ [HL_EVAL_HEADLESS_ENV]: '1' }, true)).toBe(false);
  });

  it('без флага и с прочими значениями — окно создаётся как раньше', () => {
    expect(evalHeadlessEnabled({}, false)).toBe(false);
    expect(evalHeadlessEnabled({ [HL_EVAL_HEADLESS_ENV]: '' }, false)).toBe(false);
    expect(evalHeadlessEnabled({ [HL_EVAL_HEADLESS_ENV]: '0' }, false)).toBe(false);
    expect(evalHeadlessEnabled({ [HL_EVAL_HEADLESS_ENV]: 'true' }, false)).toBe(false);
  });
});
