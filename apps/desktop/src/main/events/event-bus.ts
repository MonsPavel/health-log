/**
 * TASK-009 §5: типизированная шина событий main-процесса. Карта имён/payload —
 * HlEventMap из @hl/contracts (§11: новое событие = расширение карты, механизм не
 * меняется). Своя шина вместо EventEmitter — строгая типизация и ноль зависимостей (§4).
 *
 * Семантика доставки (§13, документируется здесь — потребители не должны строить
 * state-машину на событиях, только инвалидировать/обновлять):
 *  - at-most-once, доставка только живым окнам (см. broadcast.ts);
 *  - внутри одного имени — FIFO (порядок подписки и порядок emit);
 *  - между разными именами порядка НЕТ.
 *
 * Исключения (§9/§18): emit синхронный; падение одного обработчика не рвёт цепочку
 * остальных — try/catch на каждый handler, ошибка логируется (категория events).
 */
import type { HlEventMap } from '@hl/contracts';

/** Лог каркаса событий (§18); реальный main-логгер подключится своей задачей (TASK-010). */
export interface EventsLogger {
  debug(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
}

/** Консольный логгер; категория `events` — префикс каждой записи (§18). */
export function createConsoleEventsLogger(): EventsLogger {
  return {
    debug: (message, meta) => console.debug('[events]', message, meta),
    error: (message, meta) => console.error('[events]', message, meta),
  };
}

/** Обработчик события имени K: получает только payload, без объекта event. */
export type HlEventHandler<K extends keyof HlEventMap> = (payload: HlEventMap[K]) => void;

/**
 * Стирание типа обработчика для хранения в одном Set: любой HlEventHandler<K>
 * принимаем за (payload: never) => void — never присваиваем любому payload, обратный
 * cast выполняется в момент вызова с уже известным K.
 */
type StoredHandler = (payload: never) => void;

/** Шина событий приложения (§5): on/once/off/emit поверх Map<name, Set<handler>>. */
export class EventBus {
  private readonly handlers = new Map<keyof HlEventMap, Set<StoredHandler>>();

  constructor(private readonly logger: EventsLogger = createConsoleEventsLogger()) {}

  /** Подписка; возвращает функцию отписки (удобно для useEffect/cleanup, §10). */
  on<K extends keyof HlEventMap>(name: K, handler: HlEventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
    return () => {
      this.off(name, handler);
    };
  }

  /** Разовая подписка: снимается ДО вызова обработчика (Node-семантика once). */
  once<K extends keyof HlEventMap>(name: K, handler: HlEventHandler<K>): () => void {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /** Отписка; несуществующая пара имя/handler — no-op (идемпотентность). */
  off<K extends keyof HlEventMap>(name: K, handler: HlEventHandler<K>): void {
    this.handlers.get(name)?.delete(handler);
  }

  /**
   * Синхронная доставка всем подписчикам имени (§9). Снимок подписчиков ([...set])
   * — защита от мутаций множества во время обхода (обработчик отписывается сам или
   * соседа). Исключение изолируется на каждый handler (§9, §20).
   */
  emit<K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]): void {
    const set = this.handlers.get(name);
    if (set === undefined) {
      return;
    }
    for (const handler of [...set]) {
      try {
        (handler as HlEventHandler<K>)(payload);
      } catch (cause) {
        this.logger.error('обработчик события упал — доставка остальным продолжается', {
          name,
          cause,
        });
      }
    }
  }
}
