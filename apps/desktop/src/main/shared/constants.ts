/**
 * TASK-023 §6: константа пути файла хранилища ключа БД в shared — имя файла
 * `vault.key` (файл лежит в userData: `<userData>/vault.key`, §2/§9).
 *
 * Имя — единственный источник истины: контейнер (TASK-027) собирает полный путь
 * `join(app.getPath('userData'), VAULT_KEY_FILENAME)` и передаёт адаптеру KeyVault
 * (зоны арх. 03 §4: adapters shared не импортируют — путь вводится зависимостью).
 * Переименование файла = миграция существующих установок (TASK-023 §22: снос/потеря
 * файла при существующей БД = VAULT/KEY_MISSING) — осознанная правка этого файла.
 */

/** Имя файла хранилища wrapped-ключа БД (TASK-023 §5: JSON {v, wrapped, createdUtc}). */
export const VAULT_KEY_FILENAME = 'vault.key';
