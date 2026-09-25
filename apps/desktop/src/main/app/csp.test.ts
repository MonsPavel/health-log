/**
 * TASK-008 §6/§14: политика CSP окна. База — `default-src 'self'; script-src 'self'`
 * (prod: только собранные ассеты своего origin). В dev добавляется разрешение
 * vite-хоста (§6): origin для скриптов + inline-preamble @vitejs/plugin-react
 * ('unsafe-inline' — ТОЛЬКО dev, §22: «CSP может сломать HMR») и ws:// для
 * HMR-websocket (connect-src).
 */
import { describe, expect, it } from 'vitest';

import { buildCspPolicy } from './csp.js';

const DEV_URL = 'http://127.0.0.1:5183';

describe('buildCspPolicy — prod (§14: default-src self)', () => {
  it('в prod — строгая политика без послаблений', () => {
    expect(buildCspPolicy(undefined)).toBe("default-src 'self'; script-src 'self'");
  });
});

describe('buildCspPolicy — dev (§6: dev-разрешение vite-хоста)', () => {
  it('разрешает origin dev-сервера в script-src', () => {
    const policy = buildCspPolicy(DEV_URL);

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain(`script-src 'self' ${DEV_URL}`);
  });

  it('dev: разрешает inline-скрипты (preamble react-refresh, §22) — только в dev', () => {
    expect(buildCspPolicy(DEV_URL)).toContain(
      "script-src 'self' http://127.0.0.1:5183 'unsafe-inline'",
    );
    expect(buildCspPolicy(undefined)).not.toContain('unsafe-inline');
  });

  it('dev: разрешает HMR-websocket того же host:port в connect-src', () => {
    expect(buildCspPolicy(DEV_URL)).toContain(
      "connect-src 'self' http://127.0.0.1:5183 ws://127.0.0.1:5183",
    );
  });

  it('невалидный dev-URL — откат к строгой prod-политике', () => {
    expect(buildCspPolicy('not-a-url')).toBe("default-src 'self'; script-src 'self'");
    expect(buildCspPolicy('')).toBe("default-src 'self'; script-src 'self'");
  });
});
