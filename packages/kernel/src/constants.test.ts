// TASK-006 §19: константы порога «мало данных» (FR-5.4) — правило живёт в одном месте.
import { describe, expect, it } from 'vitest';

import { AI_MIN_DAYS, AI_MIN_MEASUREMENTS } from './constants.js';

describe('Константы порога честного отказа ИИ (§5, FR-5.4)', () => {
  it('AI_MIN_MEASUREMENTS = 7', () => {
    expect(AI_MIN_MEASUREMENTS).toBe(7);
  });

  it('AI_MIN_DAYS = 3', () => {
    expect(AI_MIN_DAYS).toBe(3);
  });
});
