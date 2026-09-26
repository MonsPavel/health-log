/**
 * TASK-023 §19/§24: ручная real-проверка KeyVault на РЕАЛЬНОМ Electron safeStorage
 * (Windows DPAPI / macOS Keychain) — локальная проверка, в `pnpm test` и CI не входит
 * (§19: real safeStorage на CI-ubuntu недоступен). Запуск: `pnpm test:vault-real`
 * (сначала пересобирает kernel и main-процесс, затем гоняет этот скрипт под Electron).
 *
 * Сценарий (кейсы §13 на реальном keyring):
 *  1. ensureKey(false) ×2 — created=true и ключ стабилен (кэш сессии, §13);
 *  2. grep-тест §14: файл vault.key не содержит ключа открытым текстом (64-hex);
 *  3. новый экземпляр vault-а над тем же файлом — реальная расшифровка DPAPI
 *     (created=false, ключ тот же; симуляция повторного старта приложения, §24);
 *  4. exportKeyForBackup — wrapped-blob совпадает с файлом (§5/§7).
 *
 * Файлы — во временном каталоге ОС, удаляются после прогона. Exit code: 0 — PASS, 1 — FAIL.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, safeStorage } from 'electron';

/** Логгер адаптера поверх консоли (боевой createLogger('db') недоступен вне приложения). */
const logger = {
  info: (message, meta) => console.log(`[vault-real][info] ${message}`, meta ?? ''),
  warn: (message, meta) => console.log(`[vault-real][warn] ${message}`, meta ?? ''),
};

const fail = (message) => {
  console.error(`[vault-real] FAIL: ${message}`);
  app.exit(1);
};

if (typeof app?.whenReady !== 'function') {
  console.error('[vault-real] FAIL: скрипт обязан запускаться под Electron (pnpm test:vault-real)');
  process.exit(1);
}

app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    return fail('safeStorage недоступен на этой платформе (см. TASK-023 §4: Linux без keyring)');
  }
  console.log(
    `[vault-real] safeStorage доступен: platform=${process.platform}, electron=${process.versions.electron}`,
  );

  // Адаптер импортируется из собранного main-процесса (tsc -b tsconfig.main.json в скрипте).
  const { SafeStorageKeyVault } = await import(
    '../dist/main/modules/security/adapters/safe-storage-key-vault.js'
  );

  const dir = mkdtempSync(join(tmpdir(), 'hl-vault-real-'));
  const vaultFilePath = join(dir, 'vault.key');
  const vault = new SafeStorageKeyVault({ vaultFilePath, safeStorage, logger });

  // 1) Первая установка (§13 кейс 1): ключ создан, created=true, hex 64 lowercase.
  const first = await vault.ensureKey(false);
  if (!first.ok) return fail(`первый ensureKey: ${first.error.code}`);
  if (!first.value.created) return fail('первый ensureKey: ожидался created=true');
  if (!/^[0-9a-f]{64}$/.test(first.value.keyHex)) return fail('ключ не 64-hex lowercase');

  // Кэш сессии (§13): повторный вызов возвращает тот же ключ, файл не перезаписывается.
  const second = await vault.ensureKey(false);
  if (!second.ok) return fail(`повторный ensureKey: ${second.error.code}`);
  if (second.value.keyHex !== first.value.keyHex) return fail('ключ изменился в той же сессии');

  // 2) Grep-тест §14/§20: ключа открытым текстом в файле нет.
  const fileContent = existsSync(vaultFilePath) ? readFileSync(vaultFilePath, 'utf8') : '';
  if (fileContent.length === 0) return fail('файл vault.key пуст или не создан');
  if (fileContent.includes(first.value.keyHex) || /[0-9a-f]{64}/.test(fileContent)) {
    return fail('ключ найден в vault.key открытым текстом');
  }

  // 3) Повторный старт приложения (§24): новый экземпляр расшифровывает DPAPI-обёртку.
  const reopened = new SafeStorageKeyVault({ vaultFilePath, safeStorage, logger });
  const ensured = await reopened.ensureKey(false);
  if (!ensured.ok) return fail(`расшифровка при повторном старте: ${ensured.error.code}`);
  if (ensured.value.created) return fail('повторный старт: ожидался created=false');
  if (ensured.value.keyHex !== first.value.keyHex) return fail('ключ после расшифровки не совпал');

  // 4) Экспорт wrapped-blob (§5/§7): совпадает с содержимым файла.
  const blob = await reopened.exportKeyForBackup();
  if (!blob.ok) return fail(`exportKeyForBackup: ${blob.error.code}`);
  const fileJson = JSON.parse(fileContent);
  if (blob.value.wrappedB64 !== fileJson.wrapped || blob.value.createdUtc !== fileJson.createdUtc) {
    return fail('wrapped-blob не совпадает с файлом vault.key');
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(
    `[vault-real] PASS: ключ создан и стабилен; в файле обёртка (DPAPI), ключа открытым текстом нет; повторный старт расшифровывает; export совпадает с файлом`,
  );
  return app.exit(0);
});
