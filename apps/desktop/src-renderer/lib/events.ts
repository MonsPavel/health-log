/**
 * TASK-009 §5/§10: React-хук подписки на события main→renderer через preload-мост.
 * Типизирован картой HlEventMap (contracts): имя события и payload проверяются
 * компилятором, новые события наследуются расширенной картой без изменения хука.
 *
 * Семантика отписки (§10/§22 — защита от утечек при частых mount/unmount):
 * useEffect возвращает unsubscribe моста — React вызывает его при unmount и перед
 * повторным эффектом, поэтому StrictMode-двойной mount React 18 не дублирует
 * активные подписки (проверено тестом events.test.ts).
 *
 * Обработчик — через latest-ref: подписка живёт на всём промежутке [name], смена
 * идентичности inline-коллбэка между рендерами не пересоздаёт подписку, вызывается
 * всегда последний обработчик.
 */
import { useEffect, useRef } from 'react';

import type { HlBridge, HlEventMap } from '@hl/contracts';

declare global {
  interface Window {
    /** Мост из preload.cts (namespace `hl` — §5, арх. 08 §4); зеркалит ipc.ts (TASK-008). */
    readonly hl: HlBridge;
  }
}

/** Подписка на событие name на время жизни компонента; payload типизирован картой. */
export function useHlEvent<K extends keyof HlEventMap>(
  name: K,
  handler: (payload: HlEventMap[K]) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = window.hl.on(name, (payload) => {
      handlerRef.current(payload);
    });
    return unsubscribe;
  }, [name]);
}
