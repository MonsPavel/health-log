/**
 * TASK-011 §5/§10/§12/§16: системный тост — минимальный каркас ошибочных/системных
 * уведомлений рендерера. Store — локальный useState в провайдере, без zustand (§12);
 * API — showToast(AppErrorDto): текст по messageKey каталога (§17), кнопка «Закрыть».
 *
 * ОГРАНИЧЕНИЯ (§10): очередь max 3 (новейшие вытесняют старейшие — шторм ошибок не
 * заваливает экран); авто-скрытие 6 с; a11y (§16): регион role="status" +
 * aria-live="polite", фокус принудительно не уводится.
 *
 * Полноценные стили/анимации и UI-каталоги («Закрыть» как ключ) приходят с TASK-013;
 * подпись кнопки — RU-константа: ДОПУСТИМОЕ ИСКЛЮЧЕНИЕ из §17 (UI-хром, каталог
 * ошибок errors.* для неё не место), аналог диалога main (§9).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { AppErrorDto } from '@hl/contracts';

import { toUserMessage } from './errors';

/** Максимум одновременно видимых тостов (§10). */
const MAX_TOASTS = 3;
/** Авто-скрытие тоста, мс (§10). */
const AUTO_HIDE_MS = 6000;

/** Элемент очереди тостов. */
interface ToastItem {
  readonly id: number;
  readonly text: string;
}

/** API тостов, доступный дереву под провайдером (§12). */
export interface ToastApi {
  readonly showToast: (error: AppErrorDto) => void;
  /**
   * TASK-088 §5: нейтральное системное уведомление (не ошибка; «Разбор сохранён»)
   * — тот же регион/очередь/авто-скрытие, что у ошибок, без каталога ошибок.
   */
  readonly showMessage: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Доступ к showToast; вне провайдера — developer-ошибка (§12). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('useToast вызван вне ToastProvider — оберните дерево провайдером (§12)');
  }
  return api;
}

/** Провайдер тостов: очередь + a11y-регион; рендерится один раз в App (§5). */
export function ToastProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);

  const removeToast = useCallback((id: number): void => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  /** §10: очередь max 3 — старейшие вытесняются (slice от хвоста). */
  const push = useCallback((text: string): void => {
    nextId.current += 1;
    const item: ToastItem = { id: nextId.current, text };
    setItems((current) => [...current, item].slice(-MAX_TOASTS));
  }, []);

  const showToast = useCallback(
    (error: AppErrorDto): void => {
      push(toUserMessage(error));
    },
    [push],
  );

  // TASK-088 §5: нейтральный текст системного уведомления — тот же регион.
  const showMessage = useCallback(
    (text: string): void => {
      push(text);
    },
    [push],
  );

  return (
    <ToastContext.Provider value={{ showToast, showMessage }}>
      {children}
      <div role="status" aria-live="polite" data-testid="toast-region">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onClose={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Карточка тоста: текст + «Закрыть»; авто-скрытие через 6 с с очисткой таймера. */
function ToastCard({
  item,
  onClose,
}: {
  readonly item: ToastItem;
  readonly onClose: (id: number) => void;
}): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onClose(item.id), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [item, onClose]);

  return (
    <div data-testid="toast">
      <span>{item.text}</span>
      {/* §17-исключение: подпись кнопки — UI-хром, ключ появится с каталогами TASK-013 */}
      <button type="button" onClick={() => onClose(item.id)}>
        Закрыть
      </button>
    </div>
  );
}
