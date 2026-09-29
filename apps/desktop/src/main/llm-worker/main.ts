/**
 * TASK-076 §5/§6 + TASK-077 §5/§6: точка входа UtilityProcess llm-worker
 * (Electron fork'ает собранный llm-worker.js; entry — этот файл в
 * dist/main/llm-worker/main.js).
 *
 * HANDSHAKE (§5 076): main создаёт MessageChannelMain и передаёт один конец
 * воркеру через parentPort.postMessage(message, [port]) — официальный транспорт
 * UtilityProcess (§4). Воркер здесь: ловит parentPort-message с переданным
 * портом, оборачивает его в WorkerTransport и запускает цикл протокола
 * (startLlmWorkerLoop) над ДВИЖКОМ: с TASK-077 дефолт — боевой
 * createDefaultLlmEngine (node-llama-cpp за портом LlmWorkerEngine; натив —
 * ленивый, до load-запроса не грузится); заглушка notConfiguredEngine
 * остаётся для тестов каркаса (§5 «мост»).
 *
 * ВНЕ ELECTRON (§20-прецедент vault): в node-рантайме (vitest, type-stripping)
 * process.parentPort отсутствует — автостарт ниже не срабатывает, файл
 * безопасно импортируется тестами; attachToParentPort/сreatePortTransport
 * экспортированы для юнит-теста handshake-проводки.
 *
 * ОГРАНИЧЕНИЯ ФАЙЛА: без shared-импортов (БД/ключи/сеть — §8/§14, depcruise-
 * зона воркера); логи движка — stdout-адаптер llama-engine.ts (§18: pino-корень
 * в воркере не инициализирован, операционные события логирует main-клиент).
 */
import type { WorkerRequest } from '@hl/contracts';

import { createDefaultLlmEngine } from './llama-engine.js';
import {
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
 * запускает цикл протокола над внедрённым движком (дефолт — боевой
 * createDefaultLlmEngine, TASK-077; тесты подставляют свои). Повторные
 * parentPort-message игнорируются — порт передаётся один раз.
 */
export function attachToParentPort(
  parentPort: ParentPortLike,
  engine: LlmWorkerEngine = createDefaultLlmEngine(),
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
