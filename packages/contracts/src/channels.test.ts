// TASK-008 §5/§19: транспортный контракт моста — типы ChannelName/HlBridge и схема
// запроса к единой точке диспетчеризации main (§13: порядок проверок начинается с
// «канал существует?»; у Electron нет hook на invoke незарегистрированного канала,
// поэтому неизвестный канал обнаруживает каркас — §11/§20).
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CHANNEL_SCHEMAS,
  HL_INVOKE_CHANNEL,
  HL_INVOKE_REQUEST_SCHEMA,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type HlBridge,
} from './channels.js';

describe('HL_INVOKE_CHANNEL — транспортный канал main (единая точка)', () => {
  it('имя в неймспейсе hl, не пересекается с прикладными каналами (домен/действие)', () => {
    expect(HL_INVOKE_CHANNEL).toBe('hl:invoke');
  });
});

describe('HL_INVOKE_REQUEST_SCHEMA — форма запроса моста', () => {
  it('принимает {channel, payload}', () => {
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ channel: 'app/ping', payload: {} }).success).toBe(
      true,
    );
  });

  it('отклоняет запрос без channel или без payload', () => {
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ channel: 'app/ping' }).success).toBe(false);
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ payload: {} }).success).toBe(false);
  });

  it('отклоняет не-строковый channel и не-объектный запрос', () => {
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ channel: 42, payload: {} }).success).toBe(false);
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse('invoke').success).toBe(false);
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
  });
});

describe('типы реестра — компилятор выводит payload/ответ из схем (§23: без ручной синхронизации)', () => {
  it('ChannelName — строковый union прикладных каналов', () => {
    expectTypeOf<ChannelName>().toEqualTypeOf<'app/ping'>();
  });

  it('ChannelRequest для app/ping — вывод z.infer из схемы запроса', () => {
    expectTypeOf<ChannelRequest<'app/ping'>>().toEqualTypeOf<{}>();
  });

  it('ChannelResponse для app/ping — {pong: true, ts: number}', () => {
    expectTypeOf<ChannelResponse<'app/ping'>>().toEqualTypeOf<{ pong: true; ts: number }>();
  });

  it('HlBridge.invoke требует известный ChannelName — «дозвониться» до чужого канала нельзя (арх. 05 §1)', async () => {
    const bridge = {} as HlBridge;

    expectTypeOf(bridge.invoke('app/ping', {})).toEqualTypeOf<Promise<unknown>>();
    // @ts-expect-error неизвестный канал отклонён типом — контракту не нужен рантайм-реестр в рендерере
    bridge.invoke('app/nope', {});
    expect(Object.keys(CHANNEL_SCHEMAS)).toEqual(['app/ping']);
  });
});
