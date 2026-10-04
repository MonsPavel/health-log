/**
 * TASK-035 §6/§9: RED-тест чтения HL_TEST_USER_DATA — e2e (Playwright _electron)
 * изолирует приложение в tmp-каталоге через переменную окружения; bootstrap
 * подставляет её вместо app.getPath('userData') ТОЛЬКО когда она задана.
 *
 * TASK-119 §3/§4 (находка F2 аудита 2026-Q1 §4): контракт «setPath применяется» —
 * applyUserDataOverride зовёт app.setPath('userData', override) при заданной
 * непустой переменной и НЕ зовёт без неё (Chromium-слой: localStorage, кэши).
 * Electron-зависимость — структурный мок app (прецедент: чистая функция без
 * импорта electron, шапка user-data-override.ts).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyUserDataOverride,
  HL_TEST_USER_DATA_ENV,
  resolveUserDataPath,
} from './user-data-override.js';

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

describe('applyUserDataOverride — контракт «setPath применяется» (TASK-119)', () => {
  it(`переменная задана — app.setPath('userData', override) с тем же путём`, () => {
    const setPath = vi.fn();
    const tmp = 'C:\\tmp\\hl-e2e-xyz';

    applyUserDataOverride({ setPath }, { [HL_TEST_USER_DATA_ENV]: tmp });

    expect(setPath).toHaveBeenCalledTimes(1);
    expect(setPath).toHaveBeenCalledWith('userData', tmp);
  });

  it('переменная не задана — setPath не вызывается (боевой профиль не тронут)', () => {
    const setPath = vi.fn();

    applyUserDataOverride({ setPath }, {});

    expect(setPath).not.toHaveBeenCalled();
  });

  it('переменная пустая строка — setPath не вызывается (та же трактовка, что у resolveUserDataPath)', () => {
    const setPath = vi.fn();

    applyUserDataOverride({ setPath }, { [HL_TEST_USER_DATA_ENV]: '' });

    expect(setPath).not.toHaveBeenCalled();
  });
});
