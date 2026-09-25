/**
 * TASK-007 §19: автотест изоляции процессов — фабрика createWindowOptions() чистая,
 * webPreferences читаются без запуска Electron. §20.3: contextIsolation=true,
 * sandbox=true, nodeIntegration=false; webSecurity=true — из §5 (флаги окна).
 */
import { describe, expect, it } from 'vitest';

import { createWindowOptions } from './create-window-options.js';

describe('createWindowOptions', () => {
  it('включает изоляцию рендерера: contextIsolation=true, sandbox=true, nodeIntegration=false (§20.3)', () => {
    const options = createWindowOptions();

    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
  });

  it('включает webSecurity (§5 — флаги окна обязательны, §14)', () => {
    const options = createWindowOptions();

    expect(options.webPreferences?.webSecurity).toBe(true);
  });
});
