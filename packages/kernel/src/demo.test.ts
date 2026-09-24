// ВРЕМЕННЫЙ демо-тест (§20 TASK-004): доказывает, что Vitest собирает colocated-тесты
// в packages/kernel. Удаляется в TASK-006, когда в kernel появятся реальные доменные тесты.
import { describe, expect, it } from 'vitest';

import * as kernel from './index.js';

describe('@hl/kernel: демо тестовой инфраструктуры', () => {
  it('модуль загружается в тестовом окружении', () => {
    expect(kernel).toBeTypeOf('object');
  });
});
