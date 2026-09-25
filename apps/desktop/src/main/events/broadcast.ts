/**
 * TASK-009 §5: доставка событий всем живым webContents — broadcastToWindows(name, payload)
 * по ЕДИНОМУ транспортному каналу `hl:event` с конвертом {name, payload} (§11); подписка
 * и разбор конверта — на стороне preload (`window.hl.on`, §5/§10).
 *
 * Fire-and-forget (§9): ошибки send (уничтоженное окно) глушатся с логом debug —
 * broadcast не возвращает результат и не бросает. Cleanup dead-окон (§5):
 *  - проверка isDestroyed при каждой отправке (окно могло закрыться между событиями);
 *  - отписка по событию 'destroyed' — ссылка на webContents удаляется из реестра,
 *    чтобы закрытые окна не удерживались от сборщика мусора.
 *
 * Шумодав (§15): события с частотой >20/с (стрим токенов) пойдут отдельным каналом
 * `hl:stream` в P5 — НЕ через эту шину.
 *
 * Семантика доставки — см. event-bus.ts (§13): at-most-once, только активным окнам;
 * буферизация для скрытых окон НЕ предусмотрена сознательно — рендерер перечитывает
 * состояние через query-инвалидацию (§5).
 */
import { webContents } from 'electron';

import { HL_EVENT_CHANNEL, type HlEventMap } from '@hl/contracts';

import { createConsoleEventsLogger, type EventsLogger } from './event-bus.js';

/**
 * Минимальная форма webContents, нужная бродкастеру (§19: fake с spy send в тестах;
 * структурно совместимо с Electron.WebContents).
 */
export interface BroadcastTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'destroyed', listener: () => void): void;
}

/** Зависимости бродкастера — точка подстановки фейков в тестах (§19). */
export interface BroadcastDeps {
  /** Источник живых webContents (Electron: webContents.getAllWebContents). */
  readonly getAllTargets: () => readonly BroadcastTarget[];
  readonly logger: EventsLogger;
}

/** Функция доставки: payload типизирован картой событий (§11). */
export interface BroadcastToWindows {
  <K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]): void;
}

/**
 * Фабрика моста. Реестр целей пополняется из getAllTargets при каждой доставке;
 * каждая цель ровно один раз подписывается на 'destroyed' и снимается с рассылки.
 */
export function createBroadcastToWindows(deps: BroadcastDeps): BroadcastToWindows {
  const tracked = new Set<BroadcastTarget>();

  const track = (target: BroadcastTarget): void => {
    if (tracked.has(target)) {
      return;
    }
    tracked.add(target);
    target.once('destroyed', () => {
      tracked.delete(target);
    });
  };

  return (name, payload) => {
    for (const target of deps.getAllTargets()) {
      track(target);
    }
    for (const target of tracked) {
      // §5: isDestroyed проверяется при отправке — окно могло закрыться после 'destroyed'-события.
      if (target.isDestroyed()) {
        tracked.delete(target);
        continue;
      }
      try {
        target.send(HL_EVENT_CHANNEL, { name, payload });
      } catch (cause) {
        deps.logger.debug('broadcast: доставка не удалась (окно уничтожено?)', { name, cause });
      }
    }
  };
}

/** Зависимости приложения: реальные webContents + консольный лог категории events (§18). */
function electronDeps(): BroadcastDeps {
  return {
    getAllTargets: () => webContents.getAllWebContents(),
    logger: createConsoleEventsLogger(),
  };
}

/**
 * Мост приложения (создаётся один раз при импорте; публикаторы — будущие задачи,
 * TASK-011/026/087 — вызывают broadcastToWindows из main, §5).
 */
export const broadcastToWindows: BroadcastToWindows = createBroadcastToWindows(electronDeps());
