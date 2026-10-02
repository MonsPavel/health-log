/**
 * TASK-097 §5: юнит-тесты извлечения версии приложения из userAgent — упрощение
 * «локально из процесса» (§5). РЕАЛЬНЫЙ layout UA Electron (shell/common/
 * application_info.cc строит '<name>/<version> Chrome/<x> Electron/<y>', Chromium
 * BuildUserAgentFromProduct дописывает Safari-токен последним): токен приложения
 * (health-log/<версия>, electron-builder.yml extraMetadata) стоит В СЕРЕДИНЕ
 * строки, перед ' Chrome/' — ревью 097: привязка к концу строки ловила только
 * несуществующий layout (тесты зелёные — фича мертва в проде).
 *
 * Канал app/meta с полем appVersion — TASK-100 (todo), до него — разбор UA;
 * токена перед ' Chrome/' нет (не Electron, нестандартный агент) — undefined:
 * UI показывает «—» (строка не врёт).
 *
 * Имя в токене не анализируется (может содержать @ и / — dev-имя пакета) —
 * извлекается только версия. Сегмент '5.0' (Mozilla/5.0) и '537.36'
 * (AppleWebKit/537.36) не проходят шаблон x.y.z.
 */
import { describe, expect, it } from 'vitest';

import { extractAppVersion } from './app-version';

describe('extractAppVersion — токен Name/version перед « Chrome/» (§5 упрощение, ревью 097)', () => {
  it('упакованный UA: health-log/1.0.0 перед Chrome/ → 1.0.0', () => {
    expect(
      extractAppVersion(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) health-log/1.0.0 Chrome/126.0.0.0 Electron/44.4.5 Safari/537.36',
      ),
    ).toBe('1.0.0');
  });

  it('dev-имя пакета с @ и / в токене: @hl/desktop/0.0.0 → 0.0.0', () => {
    expect(
      extractAppVersion(
        'Mozilla/5.0 (win32; x64) AppleWebKit/537.36 (KHTML, like Gecko) @hl/desktop/0.0.0 Chrome/126.0.0.0 Electron/44.4.5 Safari/537.36',
      ),
    ).toBe('0.0.0');
  });

  it('пре-релизная версия: health-log/1.2.3-beta.4 → 1.2.3-beta.4', () => {
    expect(
      extractAppVersion(
        'Mozilla/5.0 (win32; x64) AppleWebKit/537.36 (KHTML, like Gecko) health-log/1.2.3-beta.4 Chrome/126.0.0.0 Electron/44.4.5 Safari/537.36',
      ),
    ).toBe('1.2.3-beta.4');
  });

  it('перед « Chrome/» нет токена Name/version — undefined (UI покажет «—»)', () => {
    expect(
      extractAppVersion(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBeUndefined();
  });

  it('UA без « Chrome/» вообще (jsdom) — undefined', () => {
    expect(
      extractAppVersion('Mozilla/5.0 (win32) AppleWebKit/537.36 jsdom/26.1.0'),
    ).toBeUndefined();
  });
});
