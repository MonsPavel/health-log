import type { IpcRendererEvent } from 'electron';

import electron = require('electron');

/**
 * Preload-мост `window.hl` (TASK-008 §5): единственная точка доступа рендерера к main
 * (арх. 08 §4 — preload только contextBridge). Валидация payload — в main (zod, §14);
 * мост только перенаправляет вызовы и события.
 *
 * invoke уходит ЕДИНЫМ транспортным каналом `hl:invoke` с {channel, payload}: проверку
 * «канал существует?» и zod-валидацию выполняет каркас main (§11/§13), у Electron нет
 * hook на invoke незарегистрированного канала. Строка дублируется намеренно: sandbox-
 * preload не может импортировать @hl/contracts (CJS без бандлера); дрейф константы
 * даёт громкую ошибку «No handler registered» в dev (комментарий register-channel.ts).
 *
 * on(name, cb) — подписка на событие шины main→renderer (TASK-009 §5/§11): события
 * идут единым транспортным каналом `hl:event` с конвертом {name, payload} (зеркало
 * contracts.HL_EVENT_CHANNEL — та же причина дублирования строки); preload разбирает
 * конверт и вызывает слушателя только своего имени. Payload-валидация на принимающей
 * стороне — будущая работа (обе стороны одной сборки, §5/арх. 05 §6). Возвращает
 * функцию отписки.
 *
 * Файл — .cts: пакет ESM («type»: «module»), а sandbox-preload обязан быть CommonJS
 * (§22) — TypeScript компилирует .cts только в CJS (dist/main/preload.cjs). Отсюда
 * verbatim-совместимый CJS-синтаксис `import = require` (verbatimModuleSyntax,
 * TASK-002 §13, отключение запрещено).
 */
const HL_INVOKE_CHANNEL = 'hl:invoke';

/** Транспортный канал событий; близнец — contracts.HL_EVENT_CHANNEL (см. шапку). */
const HL_EVENT_CHANNEL = 'hl:event';

/** Форма запроса к транспортному каналу; схема-близнец — contracts.HL_INVOKE_REQUEST_SCHEMA. */
interface InvokeRequest {
  readonly channel: string;
  readonly payload: unknown;
}

/** Конверт события на транспортном канале; близнец — broadcast.ts (§11). */
interface EventEnvelope {
  readonly name: string;
  readonly payload: unknown;
}

/** Подписка на событие main→renderer: listener получает payload без объекта event. */
type EventListener = (payload: unknown) => void;

electron.contextBridge.exposeInMainWorld('hl', {
  invoke: (channel: string, payload: unknown): Promise<unknown> =>
    electron.ipcRenderer.invoke(HL_INVOKE_CHANNEL, { channel, payload } satisfies InvokeRequest),

  on: (name: string, listener: EventListener): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, envelope: unknown): void => {
      // Битый/чужой конверт молча игнорируется: у моста нет лога (арх. 08 §4), а
      // неверная форма — дрейф сборок main/preload, диагностируемый в dev (§5).
      if (
        typeof envelope === 'object' &&
        envelope !== null &&
        (envelope as EventEnvelope).name === name
      ) {
        listener((envelope as EventEnvelope).payload);
      }
    };
    electron.ipcRenderer.on(HL_EVENT_CHANNEL, wrapped);
    return () => {
      electron.ipcRenderer.removeListener(HL_EVENT_CHANNEL, wrapped);
    };
  },
});
