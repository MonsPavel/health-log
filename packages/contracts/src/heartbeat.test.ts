// TASK-095 §5/§11/§19: контракт heartbeat-канала — сигнал пользовательской активности
// рендерера для корректного автоблока (эпик 6.1). Рендерер шлёт `app/heartbeat` на
// pointerdown/keydown с троттлом 30 с (§5); main продлевает окно автоблока
// (VaultService.touchActivity). Канал НЕ secure (§9/§11): активность продлевает
// сессию и в locked — инвентарь vault.test.ts (OPEN_CHANNELS).
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ChannelName, ChannelRequest, ChannelResponse } from './channels.js';
import { CHANNEL_SCHEMAS } from './schemas.js';
import { HEARTBEAT_REQUEST_SCHEMA, HEARTBEAT_RESPONSE_SCHEMA } from './heartbeat.js';

describe('канал app/heartbeat — форма payload (TASK-095 §11)', () => {
  it('запрос {} strict — без параметров; лишние поля отклонены (§14)', () => {
    expect(HEARTBEAT_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(HEARTBEAT_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
    expect(HEARTBEAT_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
  });

  it('ответ null — fire-and-forget (§9: прецедент app/reveal-path)', () => {
    expect(HEARTBEAT_RESPONSE_SCHEMA.safeParse(null).success).toBe(true);
    expect(HEARTBEAT_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('типы запроса/ответа выведены из реестра схем (§23)', () => {
    expectTypeOf<ChannelRequest<'app/heartbeat'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<ChannelResponse<'app/heartbeat'>>().toEqualTypeOf<null>();
  });

  it('канал присутствует в реестре схем и НЕ secure (§11: доступен при locked)', () => {
    expect(Object.keys(CHANNEL_SCHEMAS)).toContain('app/heartbeat');
    expect((CHANNEL_SCHEMAS['app/heartbeat'] as { secure?: boolean }).secure).not.toBe(true);
  });

  it('имя канала входит в union ChannelName (компилятор не даст забыть)', () => {
    // Проверка типов: присвоение имени канала переменной типа ChannelName компилируется.
    const name: ChannelName = 'app/heartbeat';
    expect(name).toBe('app/heartbeat');
  });
});
