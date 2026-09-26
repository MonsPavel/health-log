/**
 * TASK-031 §13/§19: тест сборки takenAt формы — семантика kernel Instant
 * (utcMs + tzOffsetMin, арх. 04 §2), рендерер НЕ импортирует @hl/kernel
 * (депкруз-правило renderer-not-node) — арифметика повторена локально.
 *
 * Инварианты: utcMs + tzOffsetMin·60_000 = настенное время ввода (UTC-компоненты
 * Date.UTC); «сейчас» — момент submit, не открытия формы (§13 — час передаёт тест).
 */
import { describe, expect, it } from 'vitest';

import { MS_PER_MINUTE, fromLocalWall, tzOffsetMinOf } from './taken-at';

describe('fromLocalWall — datetime-local строка → Instant (§13)', () => {
  it('локальная стена 2026-09-25 21:30 при tzOffsetMin=180 → utcMs сдвинут на -3ч', () => {
    const instant = fromLocalWall({ y: 2026, mo: 9, d: 25, h: 21, mi: 30 }, 180);
    if (instant === null) {
      throw new Error('полный ввод не может быть null');
    }

    expect(instant.tzOffsetMin).toBe(180);
    // Date.UTC(2026, 8, 25, 21, 30) — стена; utc = стена - offset.
    const expectedUtcMs = Date.UTC(2026, 8, 25, 21, 30) - 180 * MS_PER_MINUTE;
    expect(instant.utcMs).toBe(expectedUtcMs);
    // Инвариант Instant: utcMs + offset·мин = стена (восстановление компонентов).
    const wall = new Date(instant.utcMs + instant.tzOffsetMin * MS_PER_MINUTE);
    expect(wall.getUTCFullYear()).toBe(2026);
    expect(wall.getUTCMonth()).toBe(8);
    expect(wall.getUTCDate()).toBe(25);
    expect(wall.getUTCHours()).toBe(21);
    expect(wall.getUTCMinutes()).toBe(30);
  });

  it('отрицательный offset (UTC-5 → -300) и переход через полночь (§13)', () => {
    const instant = fromLocalWall({ y: 2026, mo: 1, d: 1, h: 0, mi: 15 }, -300);
    if (instant === null) {
      throw new Error('полный ввод не может быть null');
    }

    expect(instant.tzOffsetMin).toBe(-300);
    const wall = new Date(instant.utcMs + instant.tzOffsetMin * MS_PER_MINUTE);
    expect(wall.getUTCFullYear()).toBe(2026);
    expect(wall.getUTCMonth()).toBe(0);
    expect(wall.getUTCDate()).toBe(1);
    expect(wall.getUTCHours()).toBe(0);
    expect(wall.getUTCMinutes()).toBe(15);
  });

  it('неполные компоненты (только дата, без времени) → null (клиентская ошибка)', () => {
    expect(fromLocalWall({ y: 2026, mo: 9, d: 25 }, 180)).toBeNull();
  });
});

describe('tzOffsetMinOf — смещение устройства (§13: инвертированный знак getTimezoneOffset)', () => {
  it('инверсия знака Date.getTimezoneOffset (UTC+3 → 180)', () => {
    const nowMs = Date.UTC(2026, 8, 25, 12, 0, 0);
    expect(tzOffsetMinOf(nowMs)).toBe(-new Date(nowMs).getTimezoneOffset());
  });
});
