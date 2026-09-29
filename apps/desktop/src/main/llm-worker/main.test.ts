/**
 * TASK-076 §5/§19: юнит-тест handshake-проводки входа воркера (main.ts):
 * parentPort-message с переданным портом запускает цикл протокола; complete
 * против заглушки движка возвращается адресным error ENGINE_NOT_CONFIGURED;
 * порт без handshake / parentPort-message без порта цикл не запускают.
 * (Автостарт в node-рантайме отсутствует — сам импорт main.ts безопасен.)
 */
import { describe, expect, it } from 'vitest';

import { WORKER_ERROR } from './protocol.js';
import { attachToParentPort, createPortTransport } from './main.js';

type MessageListener = (event: { data?: unknown; ports?: readonly unknown[] }) => void;

/** Fake переданного порта (структура PortLike main.ts). */
class FakePort {
  readonly sent: unknown[] = [];
  started = false;
  private listener: ((event: { data: unknown }) => void) | undefined;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  on(_event: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }

  start(): void {
    this.started = true;
  }

  /** Симуляция запроса main через реальный MessagePortMain ({data}-конверт). */
  receive(raw: unknown): void {
    this.listener?.({ data: raw });
  }
}

/** Fake process.parentPort: ловит подписку на handshake-message. */
class FakeParentPort {
  private listener: MessageListener | undefined;

  on(_event: 'message', listener: MessageListener): void {
    this.listener = listener;
  }

  /** Симуляция parentPort.postMessage(..., [port]) со стороны main. */
  deliverPort(port: FakePort | undefined): void {
    this.listener?.({ ports: port === undefined ? [] : [port] });
  }
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('attachToParentPort — handshake UtilityProcess (§5)', () => {
  it('переданный порт запускает цикл: complete → адресный error ENGINE_NOT_CONFIGURED (§5)', async () => {
    const parentPort = new FakeParentPort();
    const port = new FakePort();
    attachToParentPort(parentPort);

    parentPort.deliverPort(port);
    expect(port.started).toBe(true);

    port.receive({
      type: 'complete',
      requestId: 'gen-1',
      messages: [{ role: 'user', content: 'вопрос' }],
      maxTokens: 4,
    });
    await tick();

    expect(port.sent).toEqual([
      { type: 'error', requestId: 'gen-1', code: WORKER_ERROR.ENGINE_NOT_CONFIGURED },
    ]);
  });

  it('parentPort-message без порта и повторный handshake цикл не запускают', async () => {
    const parentPort = new FakeParentPort();
    const first = new FakePort();
    attachToParentPort(parentPort);

    parentPort.deliverPort(undefined);
    expect(first.started).toBe(false);

    parentPort.deliverPort(first);
    expect(first.started).toBe(true);

    const second = new FakePort();
    parentPort.deliverPort(second);
    expect(second.started).toBe(false); // порт передаётся один раз
  });
});

describe('createPortTransport — адаптер MessagePortMain (§5)', () => {
  it('postMessage уходит в порт; подписка вызывает listener с {data} и стартует порт', () => {
    const port = new FakePort();
    const received: unknown[] = [];

    const transport = createPortTransport(port);
    transport.postMessage({ type: 'ready' });
    transport.onRequest((request) => {
      received.push(request);
    });

    expect(port.sent).toEqual([{ type: 'ready' }]);
    expect(port.started).toBe(true);
    port.receive({ type: 'unload' });
    expect(received).toEqual([{ type: 'unload' }]);
  });
});
