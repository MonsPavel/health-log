/**
 * TASK-008 §5/§19: тест полного круга ping-канала — реестр схем из contracts + хендлер
 * + dispatch каркаса; ответ соответствует response-схеме (contract-тест хендлера,
 * арх. 05 §1). Производительность — §15: вызов ping ≤5 мс (замер на прогретом каркасе).
 */
import { describe, expect, it, vi } from 'vitest';

import { API_ENVELOPE_VERSION, CHANNEL_SCHEMAS } from '@hl/contracts';
import { FixedClock } from '@hl/kernel';

import { createPingHandler } from './ping.js';
import { createChannelRegistry } from '../register-channel.js';

const PING = CHANNEL_SCHEMAS['app/ping'];

function pingRegistry(): ReturnType<typeof createChannelRegistry> {
  const registry = createChannelRegistry({ warn: vi.fn(), error: vi.fn() }, { isDev: false });
  registry.register('app/ping', PING, createPingHandler(new FixedClock(1_700_000_000_000, 180)));
  return registry;
}

describe('app/ping — полный круг (§5, §20)', () => {
  it('dispatch({channel, payload:{}}) → {v:1, ok:true, data:{pong:true, ts}}', async () => {
    const envelope = await pingRegistry().dispatch({ channel: 'app/ping', payload: {} });

    expect(envelope).toEqual({
      v: API_ENVELOPE_VERSION,
      ok: true,
      data: { pong: true, ts: 1_700_000_000_000 },
    });
  });

  it('ответ хендлера соответствует response-схеме реестра (арх. 05 §1, contract-test)', async () => {
    const envelope = await pingRegistry().dispatch({ channel: 'app/ping', payload: {} });

    if (!envelope.ok) {
      throw new Error('ожидалась успешная ветка конверта');
    }
    expect(PING.response.parse(envelope.data)).toEqual({ pong: true, ts: 1_700_000_000_000 });
  });

  it('невалидный payload ping отклоняется схемой до хендлера', async () => {
    const envelope = await pingRegistry().dispatch({ channel: 'app/ping', payload: { x: 1 } });

    expect(envelope.ok).toBe(false);
  });

  it('IPC-вызов ping ≤5 мс (§15; первый вызов — прогрев, замеряется второй)', async () => {
    const registry = pingRegistry();

    await registry.dispatch({ channel: 'app/ping', payload: {} });
    const start = performance.now();
    await registry.dispatch({ channel: 'app/ping', payload: {} });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThanOrEqual(5);
  });
});
