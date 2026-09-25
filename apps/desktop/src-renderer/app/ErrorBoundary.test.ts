/**
 * TASK-011 §19/§20: тест ErrorBoundary (React Testing Library, jsdom, createElement —
 * прецедент events.test.ts): компонент-исключение в потомке → fallback отрисован,
 * канал app/log-client-error вызван (mock window.hl), onError получил info (§20 п. 3).
 */
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { AppErrorBoundary, type BoundaryErrorInfo } from './ErrorBoundary';

/** Fake моста window.hl (§19, прецедент events.test.ts). */
function installFakeBridge(): { invoke: Mock } {
  const invoke = vi.fn(() => Promise.resolve({ v: 1, ok: true, data: null }));
  Object.defineProperty(window, 'hl', { configurable: true, value: { invoke }, writable: true });
  return { invoke };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

/** Потомок, бросающий исключение при render по команде (§19). */
function Boom({ fail }: { readonly fail: boolean }): ReactElement {
  if (fail) {
    throw new Error('рендер упал');
  }
  return createElement('div', null, 'обычный контент');
}

/** Fallback-проп теста: печатает info в DOM для проверок. */
function testFallback(info: BoundaryErrorInfo): ReactElement {
  return createElement('div', { 'data-testid': 'fallback' }, `${info.messageKey}|${info.digest}`);
}

function renderWithBoundary(fail: boolean, onError?: (info: BoundaryErrorInfo) => void): void {
  render(
    createElement(
      AppErrorBoundary,
      { fallback: testFallback, onError },
      createElement(Boom, { fail }),
    ),
  );
}

describe('AppErrorBoundary (§5/§10, §20 п. 3)', () => {
  it('без ошибки дети отрисованы, канал не вызывается', () => {
    const { invoke } = installFakeBridge();

    renderWithBoundary(false);

    expect(document.querySelector('[data-testid="fallback"]')).toBeNull();
    expect(document.body.textContent).toContain('обычный контент');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('компонент-исключение в потомке → fallback отрисован с ключом errors.renderer', () => {
    installFakeBridge();
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React шумит о краше — не ошибка теста

    renderWithBoundary(true);

    const fallback = document.querySelector('[data-testid="fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain('errors.renderer');
  });

  it('краш доставлен в main: канал app/log-client-error вызван с валидным отчётом', () => {
    const { invoke } = installFakeBridge();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithBoundary(true);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, report] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe('app/log-client-error');
    expect(report['code']).toBe('APP/RENDERER');
    expect(report['messageKey']).toBe('errors.renderer');
    expect(report['digest']).toMatch(/^[0-9a-f]+$/); // §7: digest для дедупликации (§18)
  });

  it('onError вызван с {messageKey, digest} (props API, §5)', () => {
    installFakeBridge();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();

    renderWithBoundary(true, onError);

    expect(onError).toHaveBeenCalledTimes(1);
    const info = onError.mock.calls[0]?.[0] as BoundaryErrorInfo;
    expect(info.messageKey).toBe('errors.renderer');
    expect(info.digest).toMatch(/^[0-9a-f]+$/);
  });

  it('fallback-проп получает children-независимый узел: ReactNode, не компонент (§5)', () => {
    // Конвенция per-feature границ (§10): fallback — функция, не класс; проверяем произвольный узел.
    const { invoke } = installFakeBridge();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const nodeFallback = (info: BoundaryErrorInfo): ReactNode =>
      createElement('span', { 'data-testid': 'node-fallback' }, info.digest);

    render(
      createElement(
        AppErrorBoundary,
        { fallback: nodeFallback },
        createElement(Boom, { fail: true }),
      ),
    );

    expect(document.querySelector('[data-testid="node-fallback"]')).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
