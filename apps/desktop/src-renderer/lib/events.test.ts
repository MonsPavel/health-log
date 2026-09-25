/**
 * TASK-009 §19: тест хука useHlEvent с Testing Library (jsdom-проект vitest).
 * Обязательные проверки (§20): подписка при mount; payload доходит до обработчика;
 * отписка при unmount (spy unsubscribe вызван). Плюс §10: StrictMode-двойной mount
 * React 18 не оставляет дублирующей подписки (семантика unsubscribe).
 */
import { cleanup, renderHook } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, expectTypeOf, it, vi, type Mock } from 'vitest';

import type { HlEventMap } from '@hl/contracts';

import { useHlEvent } from './events.js';

/** Fake моста window.hl (§19): spy on возвращает spy-отписку. */
function installFakeBridge(): { on: Mock; unsubscribe: Mock } {
  const unsubscribe = vi.fn();
  const on = vi.fn(() => unsubscribe);
  Object.defineProperty(window, 'hl', { configurable: true, value: { on }, writable: true });
  return { on, unsubscribe };
}

afterEach(cleanup);

describe('useHlEvent (§5/§10)', () => {
  it('подписывается на имя события при mount', () => {
    const { on } = installFakeBridge();

    renderHook(() => useHlEvent('measurement:changed', vi.fn()));

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith('measurement:changed', expect.any(Function));
  });

  it('payload от моста доходит до обработчика', () => {
    const { on } = installFakeBridge();
    const handler = vi.fn();

    renderHook(() => useHlEvent('measurement:changed', handler));
    const listener = on.mock.calls[0]?.[1] as (payload: unknown) => void;
    listener({ profileId: 'p1' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ profileId: 'p1' });
  });

  it('при unmount вызывается unsubscribe (§20)', () => {
    const { unsubscribe } = installFakeBridge();

    const rendered = renderHook(() => useHlEvent('app:log', vi.fn()));
    rendered.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('смена обработчика между рендерами не пересоздаёт подписку, вызывается последний', () => {
    const { on } = installFakeBridge();
    const first = vi.fn();
    const second = vi.fn();

    const rendered = renderHook(({ handler }) => useHlEvent('data:versionBumped', handler), {
      initialProps: { handler: first },
    });
    rendered.rerender({ handler: second });
    const listener = on.mock.calls[0]?.[1] as (payload: unknown) => void;
    listener({ newVersion: 7 });

    expect(on).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ newVersion: 7 });
  });

  it('StrictMode (React 18): двойной mount не дублирует активную подписку (§10)', () => {
    const { on, unsubscribe } = installFakeBridge();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(StrictMode, null, children);

    renderHook(() => useHlEvent('app:log', vi.fn()), { wrapper });

    // mount → effect → cleanup → effect: подписок две, активная — одна.
    expect(on).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

/** Тип-проверка §20: обработчик получает payload своего события карты. */
describe('типизация хука по HlEventMap', () => {
  it('payload параметр выводится из карты', () => {
    const handler = (payload: HlEventMap['data:versionBumped']): void => {
      expectTypeOf(payload.newVersion).toEqualTypeOf<number>();
    };
    void handler;
  });
});
