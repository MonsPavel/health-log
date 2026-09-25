/**
 * TASK-012 §19/§20: тесты обёртки single-instance — fake app-подобный target (Electron
 * не запускается, прецедент global-errors §19): лок false → quit синхронно и без
 * подписки (§20 п. 2); лок true → quit не зовётся, подписка second-instance установлена;
 * событие доходит до обработчика с argv второго процесса; обработчик (§9/§18) — info
 * «second-instance» без содержимого argv + фокус; focusExistingWindow — restore/show/
 * focus в трёх состояниях окна (§20 п. 3: свёрнутое / обычное / скрытое).
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

// vi.mock хойстится выше импортов — create-window.js транзитивно импортирует electron
// (BrowserWindow/shell в телах функций); в юнит-тестах он не нужен (§19: mock electron,
// прецедент TASK-008/TASK-009).
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), shell: { openExternal: vi.fn() } }));

import { focusExistingWindow, type FocusableWindow } from './create-window.js';
import {
  createSecondInstanceHandler,
  ensureSingleInstance,
  type SingleInstanceApp,
} from './single-instance.js';
import type { HlLogger } from '../shared/logger/logger.js';

/** Fake app-подобного target: lock/quit — шпионы, 'second-instance' эмитится вручную. */
function makeApp(options: { gotLock?: boolean } = {}): {
  target: SingleInstanceApp;
  lock: Mock;
  quit: Mock;
  on: Mock;
  emitSecondInstance(argv: string[]): void;
} {
  let listener: ((argv: string[]) => void) | undefined;
  const lock = vi.fn(() => options.gotLock !== false);
  const quit = vi.fn();
  const on = vi.fn((_event: 'second-instance', l: (argv: string[]) => void) => {
    listener = l;
    return undefined;
  });
  const target: SingleInstanceApp = {
    requestSingleInstanceLock: lock,
    quit,
    on: on as unknown as SingleInstanceApp['on'],
  };
  return {
    target,
    lock,
    quit,
    on,
    emitSecondInstance(argv: string[]): void {
      listener?.(argv);
    },
  };
}

/** Логгер-спай: info — шпион, остальные уровни — заглушки (§19). */
function makeLogger(): { logger: HlLogger; info: Mock } {
  const info = vi.fn();
  const logger: HlLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return { logger, info };
}

/** Fake окна (§19): шпионы состояния и методов восстановления. */
function makeWindow(minimized: boolean): {
  window: FocusableWindow;
  restore: Mock;
  show: Mock;
  focus: Mock;
} {
  const restore = vi.fn();
  const show = vi.fn();
  const focus = vi.fn();
  const window: FocusableWindow = { isMinimized: () => minimized, restore, show, focus };
  return { window, restore, show, focus };
}

describe('ensureSingleInstance — захват лока (§5/§20 п. 2)', () => {
  it('лок не получен → quit вызван синхронно, подписки second-instance нет', () => {
    const app = makeApp({ gotLock: false });
    const onSecondInstance = vi.fn();

    const got = ensureSingleInstance(onSecondInstance, app.target);

    expect(got).toBe(false);
    expect(app.lock).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1); // quit — сразу, без диалога (§5)
    expect(app.on).not.toHaveBeenCalled(); // второй процесс ничего не слушает
  });

  it('лок получен → quit не вызывается, подписка second-instance установлена', () => {
    const app = makeApp({ gotLock: true });
    const onSecondInstance = vi.fn();

    const got = ensureSingleInstance(onSecondInstance, app.target);

    expect(got).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.on).toHaveBeenCalledTimes(1);
    expect(app.on.mock.calls[0]?.[0]).toBe('second-instance');
  });

  it('second-instance → обработчик получает argv второго процесса (§23: задел на будущее)', () => {
    const app = makeApp();
    const onSecondInstance = vi.fn();
    ensureSingleInstance(onSecondInstance, app.target);

    const argv = ['C:\\Program Files\\HealthLog\\hl.exe', '--flag'];
    app.emitSecondInstance(argv);

    expect(onSecondInstance).toHaveBeenCalledTimes(1);
    expect(onSecondInstance).toHaveBeenCalledWith(argv);
  });
});

describe('createSecondInstanceHandler — лог + фокус (§9/§18/§20 п. 4)', () => {
  it('info-запись «second-instance» без содержимого argv + вызов фокуса окна', () => {
    const { logger, info } = makeLogger();
    const focusWindow = vi.fn();
    const handle = createSecondInstanceHandler({ logger, focusWindow });

    // argv с путём пользователя: содержимое не должно попасть в лог (§14 fail-closed)
    handle(['C:\\Users\\pavel.dev\\hl.exe']);

    expect(info).toHaveBeenCalledTimes(1);
    const [message, meta] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('second-instance'); // §20 п. 4: запись second-instance в логе
    expect(JSON.stringify(meta)).not.toContain('Users');
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });
});

describe('focusExistingWindow — restore/show/focus (§10/§20 п. 3)', () => {
  it('свёрнутое окно → restore, затем show, затем focus', () => {
    const { window, restore, show, focus } = makeWindow(true);

    focusExistingWindow(window);

    expect(restore).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    // §10: порядок isMinimized → restore → show → focus
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0]);
    expect(show.mock.invocationCallOrder[0]).toBeLessThan(focus.mock.invocationCallOrder[0]);
  });

  it('обычное (не свёрнутое) окно → show + focus, без restore', () => {
    const { window, restore, show, focus } = makeWindow(false);

    focusExistingWindow(window);

    expect(restore).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('скрытое окно (нет трея — «закрытое» = скрытое, §20) → show + focus, без restore', () => {
    // Скрытое (hide()) окно isMinimized() === false — тот же путь, что и обычное:
    // show возвращает окно из скрытого состояния (§20 п. 3: «закрытое» → show+focus).
    const { window, restore, show, focus } = makeWindow(false);

    focusExistingWindow(window);

    expect(restore).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('окон нет (undefined) → no-op без исключения', () => {
    expect(() => focusExistingWindow(undefined)).not.toThrow();
  });

  it('вызов без аргумента при пустом реестре окон → no-op без исключения', () => {
    // openWindows пуст (createWindow в тестах не вызывался) — дефолт не должен падать.
    expect(() => focusExistingWindow()).not.toThrow();
  });
});
