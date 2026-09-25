/**
 * TASK-007 §13/§14, арх. 08 §1/§4: гварды навигации главного окна — чистые функции
 * (тестируются без запуска Electron, прецедент createWindowOptions §19).
 *
 * Регрессии ревью task/TASK-007:
 *  1) will-navigate сравнивал строковый префикс — «http://127.0.0.1:5183.evil.test/» и
 *     «http://127.0.0.1:5183@evil.test/» начинаются с адреса dev-сервера и разрешались;
 *     разрешена навигация сравнением origin (невалидный URL → запрет).
 *  2) setWindowOpenHandler передавал в shell.openExternal любой протокол из недоверенного
 *     рендерера (file:, ms-msdt:, search-ms: — класс Follina); разрешён allowlist http/https.
 */
import { describe, expect, it } from 'vitest';

import { isExternalHttpUrl, isNavigationAllowed } from './navigation-guards.js';

const DEV = 'http://127.0.0.1:5183';

describe('isNavigationAllowed (will-navigate, §13)', () => {
  it('разрешает сам dev-сервер (тот же origin, любой путь)', () => {
    expect(isNavigationAllowed(DEV, DEV)).toBe(true);
    expect(isNavigationAllowed(`${DEV}/src/main.tsx`, DEV)).toBe(true);
    expect(isNavigationAllowed(`${DEV}/@vite/client`, DEV)).toBe(true);
  });

  it('блокирует хост-суффикс: 127.0.0.1:5183.evil.test (регрессия ревью №1)', () => {
    expect(isNavigationAllowed('http://127.0.0.1:5183.evil.test/', DEV)).toBe(false);
  });

  it('блокирует userinfo-обход: 127.0.0.1:5183@evil.test (регрессия ревью №1)', () => {
    expect(isNavigationAllowed('http://127.0.0.1:5183@evil.test/', DEV)).toBe(false);
  });

  it('блокирует другой порт и другую схему (origin включает схему и порт)', () => {
    expect(isNavigationAllowed('http://127.0.0.1:5184/', DEV)).toBe(false);
    expect(isNavigationAllowed('https://127.0.0.1:5183/', DEV)).toBe(false);
  });

  it('в prod (без dev-сервера) навигация запрещена всегда', () => {
    expect(isNavigationAllowed('http://127.0.0.1:5183/', undefined)).toBe(false);
    expect(isNavigationAllowed('https://example.org/', undefined)).toBe(false);
  });

  it('блокирует невалидный URL вместо исключения', () => {
    expect(isNavigationAllowed('not-a-url', DEV)).toBe(false);
    expect(isNavigationAllowed('', DEV)).toBe(false);
  });
});

describe('isExternalHttpUrl (setWindowOpenHandler → shell.openExternal, §13, арх. 08 §4)', () => {
  it('разрешает только http/https — «внешние ссылки»', () => {
    expect(isExternalHttpUrl('https://example.org/page')).toBe(true);
    expect(isExternalHttpUrl('http://example.org/')).toBe(true);
    expect(isExternalHttpUrl('HTTPS://EXAMPLE.ORG')).toBe(true);
  });

  it('блокирует file: и протоколы ОС (вектор класса Follina, регрессия ревью №2)', () => {
    expect(isExternalHttpUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isExternalHttpUrl('ms-msdt:Something')).toBe(false);
    expect(isExternalHttpUrl('search-ms:query=test')).toBe(false);
  });

  it('блокирует javascript: и пустую строку', () => {
    expect(isExternalHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalHttpUrl('')).toBe(false);
  });
});
