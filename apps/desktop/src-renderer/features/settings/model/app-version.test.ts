/**
 * TASK-097 §5: юнит-тесты извлечения версии приложения из userAgent — упрощение
 * «локально из процесса» (§5): Electron добавляет к navigator.userAgent хвост
 * «Name/version» (app.getName()/app.getVersion(); упаковка — health-log/<версия>).
 * Канал app/meta с полем appVersion — TASK-100 (todo), до него — разбор UA;
 * отсутствие хвоста — undefined (UI показывает «—»).
 */
import { describe, expect, it } from 'vitest';

import { extractAppVersion } from './app-version';

describe('extractAppVersion — версия из хвоста userAgent (§5 упрощение)', () => {
  it('упакованное имя/версия в хвосте — HealthLog/1.2.3 → 1.2.3', () => {
    expect(
      extractAppVersion(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Electron/33.0.0 Safari/537.36 HealthLog/1.2.3',
      ),
    ).toBe('1.2.3');
  });

  it('dev-имя пакета с @ и / в хвосте — @hl/desktop/0.0.0 → 0.0.0', () => {
    expect(extractAppVersion('Mozilla/5.0 Electron/33.0.0 Safari/537.36 @hl/desktop/0.0.0')).toBe(
      '0.0.0',
    );
  });

  it('пре-релизная версия — health-log/1.2.3-beta.4 → 1.2.3-beta.4', () => {
    expect(extractAppVersion('Mozilla/5.0 Electron/33.0.0 health-log/1.2.3-beta.4')).toBe(
      '1.2.3-beta.4',
    );
  });

  it('хвоста Name/version нет — undefined (UI покажет «—»)', () => {
    expect(extractAppVersion('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBeUndefined();
  });

  it('версия не в хвосте (Chrome/126 в середине, хвост Safari/537.36) — undefined', () => {
    expect(extractAppVersion('Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36')).toBeUndefined();
  });
});
