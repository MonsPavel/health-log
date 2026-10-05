/**
 * Драйвер S2–S4 сетевого аудита (TASK-106 дожим): Playwright _electron поверх
 * УПАКОВАННОГО exe (релизная сборка), шаги чек-листа audit-template.md §5
 * выполняет как оператор, скриншоты — docs/architecture/audits/assets/.
 * net-audit запускается ОТДЕЛЬНО (параллельный --duration), драйвер только
 * кликает. Запуск: node audit-driver.mjs <S2|S3|S4> <userDataDir> <shotPrefix>
 */
import { _electron } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve('dist-audit3/win-unpacked/Health Log.exe');
const ASSETS = resolve('../../docs/architecture/audits/assets');
mkdirSync(ASSETS, { recursive: true });

const scenario = process.argv[2];
const userData = process.argv[3];
const shot = process.argv[4] ?? scenario;

const app = await _electron.launch({
  executablePath: EXE,
  env: { ...process.env, HL_TEST_USER_DATA: userData },
});
const win = await app.firstWindow();
await win.waitForSelector('#content', { timeout: 20000 });

/** Навигация как пользователь: ссылка сайдбара (фолбэк — hash). */
async function go(name, hash) {
  try {
    await win.getByRole('link', { name }).click({ timeout: 5000 });
  } catch {
    await win.evaluate((h) => {
      window.location.hash = h;
    }, hash);
  }
  await win.waitForTimeout(800);
}

/** Переключатель согласия по части имени (фолбэк — позиция), с confirm на отключение. */
async function setConsent(match, value, index) {
  const switches = win.getByRole('switch');
  const count = await switches.count();
  let target = null;
  for (let i = 0; i < count; i += 1) {
    const s = switches.nth(i);
    const name = (await s.getAttribute('aria-label')) ?? (await s.textContent()) ?? '';
    if (match.test(name)) {
      target = s;
      break;
    }
  }
  if (target === null) target = switches.nth(index);
  const checked = (await target.getAttribute('aria-checked')) === 'true';
  if (checked === value) return `already ${value}`;
  await target.click();
  if (value === false) {
    // Отключение — с подтверждением (§5 confirm, OperationsList).
    await win.getByTestId('privacy-confirm-accept').click({ timeout: 5000 });
  }
  await win.waitForTimeout(500);
  return `set ${value}`;
}

try {
  if (scenario === 'S2') {
    await go('ИИ', '#/ai');
    await win.getByTestId('ai-tab-model').click();
    const card = win.getByTestId('model-card').first(); // реальная llama — первая в манифесте
    await card.getByTestId('model-download').click();
    await win.getByTestId('consent-confirm').click(); // согласие + старт загрузки
    await win.waitForTimeout(8000);
    await win.screenshot({ path: resolve(ASSETS, `${shot}-downloading.png`) });
    // §5 S2 шаг 3: дождаться installed (sha256) — до 10 минут.
    await card.getByTestId('model-select').waitFor({ timeout: 600000 });
    await win.screenshot({ path: resolve(ASSETS, `${shot}-installed.png`) });
    await go('Настройки', '#/settings');
    await win.getByTestId('privacy-section').waitFor({ timeout: 8000 });
    await win.waitForTimeout(1000);
    await win.screenshot({ path: resolve(ASSETS, `${shot}-journal.png`) }); // лента журнала: models.download
    console.log('S2 OK: installed + screenshots');
  } else if (scenario === 'S3') {
    await go('Настройки', '#/settings');
    console.log('updates consent:', await setConsent(/бновлен|update/i, true, 1));
    await win.waitForTimeout(2500); // prefs-мутация → refetch → consentGiven в UI (гонка первого прогона)
    await win.getByTestId('updates-check').click();
    try {
      // Если prefs ещё не долетели — UI перехватывает подсказкой: повтор после паузы.
      await win.getByTestId('updates-consent-hint').waitFor({ timeout: 2500 });
      await win.waitForTimeout(2500);
      await win.getByTestId('updates-check').click();
    } catch {
      /* подсказки нет — проверка пошла */
    }
    await win.waitForTimeout(12000); // проверка фида github (в т.ч. «ошибка фида» — проверка состоялась)
    await win.screenshot({ path: resolve(ASSETS, `${shot}-check.png`) });
    await win.waitForTimeout(1000);
    await win.screenshot({ path: resolve(ASSETS, `${shot}-journal.png`) }); // updates.check в ленте
    console.log('S3 OK: check done + screenshots');
  } else if (scenario === 'S4') {
    await go('Настройки', '#/settings');
    console.log('models revoke:', await setConsent(/одел|модел|model/i, false, 0));
    console.log('updates revoke:', await setConsent(/бновлен|update/i, false, 1));
    await win.screenshot({ path: resolve(ASSETS, `${shot}-revoked.png`) });
    // §5 S4 шаги 2–3: попытки без согласий — перехват UI, сети нет.
    await go('ИИ', '#/ai');
    await win.getByTestId('ai-tab-model').click();
    await win.getByTestId('model-card').first().getByTestId('model-download').click();
    await win.getByTestId('consent-dialog').waitFor({ timeout: 8000 }); // перехват согласие-диалогом
    await win.getByTestId('consent-cancel').click();
    await go('Настройки', '#/settings');
    await win.getByTestId('updates-check').click();
    await win.getByTestId('updates-consent-hint').waitFor({ timeout: 8000 }); // перехват подсказкой
    await win.screenshot({ path: resolve(ASSETS, `${shot}-intercepted.png`) });
    console.log('S4 OK: revoked + intercepted + screenshots; idle-окно добирает net-audit');
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  await app.close();
}
