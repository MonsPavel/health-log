// TASK-016 §7: Arm — строковый union 'left' | 'right'. Список значений — единственный
// источник для будущих потребителей (DDL CHECK — TASK-025, zod-схема — TASK-028).
import { describe, expect, it } from 'vitest';

import { ARM_VALUES, type Arm } from './arm.js';

describe('ARM_VALUES — состав руки измерения (§7)', () => {
  it('ровно два значения: left и right', () => {
    expect(ARM_VALUES).toEqual(['left', 'right']);
  });

  it('каждое значение типизируется как Arm (компилятор + рантайм-проверка)', () => {
    for (const arm of ARM_VALUES) {
      const typed: Arm = arm;

      expect(['left', 'right']).toContain(typed);
    }
  });
});
