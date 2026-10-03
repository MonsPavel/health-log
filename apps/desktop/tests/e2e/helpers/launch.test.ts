/**
 * TASK-078 §20 (AC3): юнит-тест env-проводки launchApp — fakeLlm:true добавляет
 * HL_FAKE_LLM=1 в окружение запуска (bootstrap передаст useFakeLlm в контейнер),
 * дефолт — переменной нет; bench:true — HL_BENCH=1 (прецедент TASK-062);
 * изоляция userData (HL_TEST_USER_DATA) и удаление ELECTRON_RENDERER_URL —
 * инварианты хелпера (§13).
 *
 * _electron.launch мокается (vi.mock @playwright/test): юнит проверяет ТОЛЬКО
 * сборку env — реальный запуск электрона не входит в юнит-прогон (см. спеки e2e).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.hoisted(() => vi.fn());

vi.mock('@playwright/test', () => ({
  _electron: { launch: launchMock },
}));

import { launchApp } from './launch.js';

/** Аргументы последнего вызова _electron.launch (env — интересующая часть). */
function lastLaunchEnv(): NodeJS.ProcessEnv {
  expect(launchMock).toHaveBeenCalledTimes(1);
  const options = launchMock.mock.calls[0]![0] as { env: NodeJS.ProcessEnv };
  return options.env;
}

beforeEach(() => {
  launchMock.mockReset();
  // Урок прогона 8 живой приёмки TASK-105 §20: launchApp после пина content-size
  // (детерминированный размер окна для скриншот-базлайнов) вызывает
  // app.firstWindow() + app.evaluate(setContentSize) — фейк обязан их иметь.
  launchMock.mockResolvedValue({
    firstWindow: () => Promise.resolve({}),
    evaluate: () => Promise.resolve(undefined),
  });
});

describe('launchApp — env-проводка fake-LLM (TASK-078 AC3)', () => {
  it('fakeLlm: true → env HL_FAKE_LLM=1', async () => {
    await launchApp({ userData: 'C:/tmp/user', fakeLlm: true });

    expect(lastLaunchEnv()['HL_FAKE_LLM']).toBe('1');
    expect(lastLaunchEnv()['HL_TEST_USER_DATA']).toBe('C:/tmp/user');
  });

  it('по умолчанию HL_FAKE_LLM не устанавливается', async () => {
    await launchApp({ userData: 'C:/tmp/user' });

    expect(lastLaunchEnv()['HL_FAKE_LLM']).toBeUndefined();
  });

  it('bench: true → HL_BENCH=1; флаги независимы (можно совместить)', async () => {
    await launchApp({ userData: 'C:/tmp/user', bench: true, fakeLlm: true });
    expect(lastLaunchEnv()['HL_BENCH']).toBe('1');
    expect(lastLaunchEnv()['HL_FAKE_LLM']).toBe('1');

    launchMock.mockReset();
    launchMock.mockResolvedValue({
      firstWindow: () => Promise.resolve({}),
      evaluate: () => Promise.resolve(undefined),
    });
    await launchApp({ userData: 'C:/tmp/user', bench: true });
    expect(lastLaunchEnv()['HL_BENCH']).toBe('1');
    expect(lastLaunchEnv()['HL_FAKE_LLM']).toBeUndefined();
  });

  it('testHooks: true → env HL_TEST_HOOKS=1 (TASK-102 §5/§6: крэш-тест); по умолчанию — нет', async () => {
    await launchApp({ userData: 'C:/tmp/user', testHooks: true });
    expect(lastLaunchEnv()['HL_TEST_HOOKS']).toBe('1');
    expect(lastLaunchEnv()['HL_TEST_USER_DATA']).toBe('C:/tmp/user');

    launchMock.mockReset();
    launchMock.mockResolvedValue({
      firstWindow: () => Promise.resolve({}),
      evaluate: () => Promise.resolve(undefined),
    });
    await launchApp({ userData: 'C:/tmp/user' });
    expect(lastLaunchEnv()['HL_TEST_HOOKS']).toBeUndefined();
  });
});
