/**
 * TASK-035 §6/§9: RED-тест чтения HL_TEST_USER_DATA — e2e (Playwright _electron)
 * изолирует приложение в tmp-каталоге через переменную окружения; bootstrap
 * подставляет её вместо app.getPath('userData') ТОЛЬКО когда она задана.
 */
import { describe, expect, it } from 'vitest';

import { HL_TEST_USER_DATA_ENV, resolveUserDataPath } from './user-data-override.js';

describe('resolveUserDataPath (TASK-035)', () => {
  it('переменная не задана — боевой userData без изменений', () => {
    const path = resolveUserDataPath('C:\\Users\\dev\\AppData\\Roaming\\health-log', {});

    expect(path).toBe('C:\\Users\\dev\\AppData\\Roaming\\health-log');
  });

  it(`переменная ${HL_TEST_USER_DATA_ENV} задана — её значение вместо боевого пути`, () => {
    const path = resolveUserDataPath('C:\\real\\userData', {
      [HL_TEST_USER_DATA_ENV]: 'C:\\tmp\\hl-e2e-xyz',
    });

    expect(path).toBe('C:\\tmp\\hl-e2e-xyz');
  });

  it('переменная задана пустой строкой — трактуется как не заданная (иначе путь сломается)', () => {
    const path = resolveUserDataPath('C:\\real\\userData', { [HL_TEST_USER_DATA_ENV]: '' });

    expect(path).toBe('C:\\real\\userData');
  });
});
