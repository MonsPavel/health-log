/**
 * TASK-076 §5/§6: точка входа UtilityProcess llm-worker (Electron fork'ает
 * собранный llm-worker.js; entry — этот файл в dist/main/llm-worker/main.js).
 *
 * HANDSHAKE (§5): main создаёт MessageChannelMain и передаёт один конец воркеру
 * через parentPort.postMessage(message, [port]) — официальный транспорт
 * UtilityProcess (§4). Воркер здесь: ловит parentPort-message с переданным
 * портом, оборачивает его в WorkerTransport и запускает цикл протокола
 * (startLlmWorkerLoop) над заглушкой движка (§5 «engine: not-configured» —
 * TASK-077 подменит движок, каркас и протокол не изменятся).
 *
 * ВНЕ ELECTRON (§20-прецедент vault): в node-рантайме (vitest, type-stripping)
 * process.parentPort отсутствует — автостарт ниже не срабатывает, файл
 * безопасно импортируется тестами; attachToParentPort/сreatePortTransport
 * экспортированы для юнит-теста handshake-проводки.
 *
 * ОГРАНИЧЕНИЯ ФАЙЛА: без логгера (§18 — логирует main-сторона клиента), без
 * импортов кроме каркаса протокола (воркер чист от БД/ключей/сети, §8/§14).
 */
import type { WorkerRequest } from '@hl/contracts';

import {
  notConfiguredEngine,
  startLlmWorkerLoop,
  type LlmWorkerEngine,
  type WorkerTransport,
} from './protocol.js';

/** Минимальная форма process.parentPort Electron (структурно — MessagePortMain). */
interface ParentPortLike {
  on(
    event: 'message',
    listener: (event: { readonly data?: unknown; readonly ports?: readonly unknown[] }) => void,
  ): void;
}

/** Минимальная форма переданного MessagePortMain (структурно, §19 — fake в тестах). */
interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
}

/** Адаптер переданного порта к транспорту цикла: данные message — сырой запрос. */
export function createPortTransport(port: PortLike): WorkerTransport {
  return {
    postMessage: (message) => {
      port.postMessage(message);
    },
    onRequest: (listener) => {
      // Guard контракта применяет сам цикл (§14) — сюда приходят сырые данные.
      port.on('message', (event) => {
        listener(event.data as WorkerRequest);
      });
      port.start();
    },
  };
}

/**
 * Handshake-проводка (§5): первый parentPort-message с переданным портом
 * запускает цикл протокола над внедрённым движком (дефолт — заглушка §5).
 * Повторные parentPort-message игнорируются — порт передаётся один раз.
 */
export function attachToParentPort(
  parentPort: ParentPortLike,
  engine: LlmWorkerEngine = notConfiguredEngine,
): void {
  let attached = false;
  parentPort.on('message', (event) => {
    if (attached) {
      return;
    }
    const port = event.ports?.[0] as PortLike | undefined;
    if (port === undefined) {
      return;
    }
    attached = true;
    startLlmWorkerLoop(createPortTransport(port), engine);
  });
}

// Автостарт ТОЛЬКО в Electron-воркере (в node-рантайме parentPort нет — см. шапку).
const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;
if (parentPort !== undefined) {
  attachToParentPort(parentPort);
}
