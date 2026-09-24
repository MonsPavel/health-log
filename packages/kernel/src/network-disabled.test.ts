// ВРЕМЕННЫЙ тест (§24 TASK-004): проба заглушки сети. Сам запрет живёт в setup-хуке
// тестового окружения (vitest.setup.ts, §13/§14): любой fetch() должен ронять тест
// с ошибкой «network is disabled in tests». После проверки заглушки тест удаляется —
// он не регресс-тест, а одноразовое доказательство работы запрета.
import { expect, test } from 'vitest';

test('заглушка fetch: сетевой вызов роняет тест (FR-7.2)', async () => {
  // example.invalid — TLD зарезервирован (RFC 2606), но заглушка должна сработать раньше DNS.
  await fetch('https://example.invalid/probe');
  expect.unreachable('fetch() обязан быть заблокирован заглушкой в vitest.setup.ts');
});
