/** Зонд: куда реально смотрит упакованное приложение и что видит в UI. */
import { _electron } from '@playwright/test';
import { resolve } from 'node:path';

const EXE = resolve('dist-audit3/win-unpacked/Health Log.exe');
const userData = process.argv[2];
const app = await _electron.launch({
  executablePath: EXE,
  env: { ...process.env, HL_TEST_USER_DATA: userData },
});
console.log('main userData:', await app.evaluate(({ app: a }) => a.getPath('userData')));
const win = await app.firstWindow();
await win.waitForSelector('#content', { timeout: 20000 });
try {
  await win.getByRole('link', { name: 'Настройки' }).click({ timeout: 5000 });
} catch {
  await win.evaluate(() => {
    window.location.hash = '#/settings';
  });
}
await win.waitForTimeout(1500);
const switches = win.getByRole('switch');
const n = await switches.count();
for (let i = 0; i < n; i += 1) {
  const s = switches.nth(i);
  const name = (await s.getAttribute('aria-label')) ?? '';
  const label = (await s.locator('xpath=ancestor::div[1]').textContent()) ?? '';
  console.log(`switch[${i}] aria="${name}" checked=${await s.getAttribute('aria-checked')} text="${label.slice(0, 80)}"`);
}
await win.waitForTimeout(300);
await app.close();
