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
 * on(name, cb) — заготовка шины событий main→renderer (реальная шина — TASK-009),
 * возвращает функцию отписки.
 *
 * Файл — .cts: пакет ESM («type»: «module»), а sandbox-preload обязан быть CommonJS
 * (§22) — TypeScript компилирует .cts только в CJS (dist/main/preload.cjs). Отсюда
 * verbatim-совместимый CJS-синтаксис `import = require` (verbatimModuleSyntax,
 * TASK-002 §13, отключение запрещено).
 */
const HL_INVOKE_CHANNEL = 'hl:invoke';

/** Форма запроса к транспортному каналу; схема-близнец — contracts.HL_INVOKE_REQUEST_SCHEMA. */
interface InvokeRequest {
  readonly channel: string;
  readonly payload: unknown;
}

/** Подписка на событие main→renderer: listener получает payload без объекта event. */
type EventListener = (payload: unknown) => void;

electron.contextBridge.exposeInMainWorld('hl', {
  invoke: (channel: string, payload: unknown): Promise<unknown> =>
    electron.ipcRenderer.invoke(HL_INVOKE_CHANNEL, { channel, payload } satisfies InvokeRequest),

  on: (name: string, listener: EventListener): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    electron.ipcRenderer.on(name, wrapped);
    return () => {
      electron.ipcRenderer.removeListener(name, wrapped);
    };
  },
});
