/**
 * TASK-013 §12/§19: тест фабрики QueryClient — локальные операции либо мгновенны
 * (retry: 0 — повтор не нужен), либо ошибка = результат валидации; кэш протухает
 * только через инвалидацию событиями (staleTime: Infinity, арх. 06 §3), gcTime
 * 10 минут (§12).
 */
import { describe, expect, it } from 'vitest';

import { createQueryClient } from './query-client';

describe('createQueryClient — defaultOptions (§12)', () => {
  it('retry: 0, staleTime: Infinity, gcTime: 10 минут — без переопределений вызывающих', () => {
    const client = createQueryClient();

    expect(client.getDefaultOptions().queries?.retry).toBe(0);
    expect(client.getDefaultOptions().queries?.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(client.getDefaultOptions().queries?.gcTime).toBe(10 * 60 * 1000);
  });

  it('каждый вызов — независимый клиент (нет общего синглтона-состояния)', () => {
    const a = createQueryClient();
    const b = createQueryClient();

    expect(a).not.toBe(b);
  });
});
