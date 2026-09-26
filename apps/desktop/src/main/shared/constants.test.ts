// TASK-023 §6: константа имени файла ключа — фиксируем контракт имени файла
// (переименование затрагивает существующие установки и должно быть осознанным).
import { describe, expect, it } from 'vitest';

import { VAULT_KEY_FILENAME } from './constants.js';

describe('константы shared (TASK-023 §6)', () => {
  it('имя файла хранилища ключа — vault.key (§2/§9)', () => {
    expect(VAULT_KEY_FILENAME).toBe('vault.key');
  });
});
