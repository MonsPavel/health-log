// TASK-006 §19: юнит-тесты Clock — порт, SystemClock (Date/intl), FixedClock (детерминизм NFR-10).
import { describe, expect, it } from 'vitest';

import { FixedClock, SystemClock, type Clock } from './clock.js';

describe('SystemClock — боевая реализация порта (§7)', () => {
  it('реализует интерфейс Clock структурно', () => {
    const clock: Clock = new SystemClock();

    expect(typeof clock.nowMs).toBe('function');
    expect(typeof clock.tzOffsetMin).toBe('function');
  });

  it('nowMs возвращает актуальное эпох-время (после 2000-01-01Z); прямых вызовов времени в тестах нет — §24', () => {
    const clock = new SystemClock();
    const value = clock.nowMs();

    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(Date.UTC(2000, 0, 1));
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
