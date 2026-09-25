// TASK-006 §19: юнит-тесты Clock — порт, SystemClock (Date/intl), FixedClock (детерминизм NFR-10).
import { describe, expect, it } from 'vitest';

import { FixedClock, SystemClock, type Clock } from './clock.js';

describe('SystemClock — боевая реализация порта (§7)', () => {
  it('реализует интерфейс Clock структурно', () => {
    const clock: Clock = new SystemClock();

    expect(typeof clock.nowMs).toBe('function');
    expect(typeof clock.tzOffsetMin).toBe('function');
  });

  it('nowMs возвращает текущее время (между замерами Date.now)', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const value = clock.nowMs();
    const after = Date.now();

    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('tzOffsetMin — инвертированный getTimezoneOffset (UTC+3 → 180)', () => {
    const clock = new SystemClock();

    expect(clock.tzOffsetMin()).toBe(-new Date().getTimezoneOffset());
  });
});

describe('FixedClock — детерминизм тестов (§7, §20)', () => {
  it('два последовательных вызова nowMs дают одно и то же время', () => {
    const clock = new FixedClock(1_750_000_000_000, 180);

    expect(clock.nowMs()).toBe(clock.nowMs());
  });

  it('возвращает ровно заданные ms и tz', () => {
    const clock = new FixedClock(1_750_000_000_123, -720);

    expect(clock.nowMs()).toBe(1_750_000_000_123);
    expect(clock.tzOffsetMin()).toBe(-720);
  });

  it('tzOffsetMin тоже детерминирован', () => {
    const clock = new FixedClock(0, 840);

    expect(clock.tzOffsetMin()).toBe(clock.tzOffsetMin());
  });
});
