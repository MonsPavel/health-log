/**
 * TASK-113 §19/§20 (AC-2, автоматическая репетиция): «новичок проходит
 * install→daily→data ПО ДОКУМЕНТУ». Спек повторяет шаги docs/user/*.md ДОСЛОВНО —
 * кликает только то, что названо в руководстве (кнопки/разделы/подписи полей), и
 * ассертит ровно те исходы, что документ обещает («статус включён», «Копия
 * сохранена: …», «Приложение перезапустится автоматически»). Расхождение текста
 * документа с UI = падение спека = правка docs/user в том же PR (правило §22).
 *
 * ГРАНИЦЫ РЕПЕТИЦИИ (честность, §24): (1) шаг «скачать и установить .exe» и
 * (2) сам AC-2 «реальный человек-новичок» автоматизировать нельзя — их закрывает
 * ручной прогон, фиксируемый в PR («прогнал N, замечания внесены»); эта репетиция
 * проверяет документируемую долю: первый запуск → пароль (install.md) → крупный
 * текст (install.md) → измерение (daily.md) → копия + восстановление (data.md) на
 * чистом профиле tmp-userData. Диалоги ОС (куда сохранить копию / выбор файла)
 * подменяются на границе electron API в MAIN — прецедент data-care.spec.ts;
 * всё остальное (крипта argon2+GCM, замена БД, файлы на диске) — боевое.
 *
 * ИЗОЛЯЦИЯ (урок репетиции): Chromium-профиль e2e-запуска общий
 * (%APPDATA%/Electron — в отличие от БД, tmp-userData переносит только данные),
 * и черновик формы `hl.formDraft` чужого прогона восстанавливался в форму
 * («Черновик восстановлен») с ручным «когда» — отказ MEASUREMENT/FUTURE_TIME
 * маскировался под флейк. Семантика AC-2 «чистая машина/профиль»: localStorage
 * чистится ДО шагов (фикстура) и ПОСЛЕ (прецедент data-care.spec.ts).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { collectDiagnostics } from './helpers/collect-diagnostics.js';
import { closeApp, launchApp, mainProcessLogsDir } from './helpers/launch.js';

/** Пароль приложения и пароль копии сценария (разные — как требует data.md). */
const APP_PASSPHRASE = 'пароль-приложения-113';
const BACKUP_PASSPHRASE = 'пароль-копии-113';

/** Мутабельная поверхность app для подавления самоперезапуска (§9 → эмуляция). */
interface MutableElectronApp {
  relaunch: () => void;
  exit: (code?: number) => void;
}

/** Фикстуры — зеркало data-care.spec (tmp-userData + страховка закрытия). */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-novice-'));
    await use(dir);
    if (testInfo.status !== testInfo.expectedStatus) {
      await collectDiagnostics({
        userDataDir: dir,
        logsDir: mainProcessLogsDir(),
        destDir: testInfo.outputPath('failure-diagnostics'),
      });
    }
    await rm(dir, { recursive: true, force: true });
  },
  launch: async ({}, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (userData: string) => {
      const app = await launchApp({ userData });
      // «Чистая машина/профиль» (AC-2): черновики и локальные настройки прошлых
      // прогонов из общего Chromium-профиля новичку не достаются.
      for (const page of app.windows()) {
        await page
          .evaluate(() => {
            (globalThis as { localStorage?: { clear: () => void } }).localStorage?.clear();
          })
          .catch(() => undefined);
      }
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      // Не оставляем свой hl.formDraft следующим прогонам (§20 повторный прогон).
      for (const page of app.windows()) {
        await page
          .evaluate(() => {
            (globalThis as { localStorage?: { clear: () => void } }).localStorage?.clear();
          })
          .catch(() => undefined);
      }
      await closeApp(app).catch(() => undefined);
    }
  },
});

/** Подмена диалогов ОС + подавление самоперезапуска (прецедент data-care.spec). */
async function stubOsDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, app: electronApp }) => {
    const state: { savePath?: string; openPaths: string[] } = { openPaths: [] };
    (globalThis as { __hlE2eDialogState?: unknown }).__hlE2eDialogState = state;
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () =>
      Promise.resolve(
        state.savePath === undefined
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePath: state.savePath },
      );
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () =>
      Promise.resolve(
        state.openPaths.length === 0
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: state.openPaths },
      );
    (electronApp as unknown as MutableElectronApp).relaunch = () => undefined;
    (electronApp as unknown as MutableElectronApp).exit = () => undefined;
  });
}

test.describe('Репетиция прогона новичка по документу (TASK-113 §20 AC-2, install→daily→data)', () => {
  test('первый запуск → пароль → крупный текст → измерение → копия → восстановление', async ({
    tmpUserData,
    launch,
  }) => {
    // Репетиция с двумя запусками приложения и восстановлением БД длиннее
    // дефолтных 30 с конфига — явный бюджет (§15: детерминизм, не скорость).
    test.setTimeout(120_000);

    // ── Первый запуск (install.md «Первый запуск»): окно открылось, входа нет.
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // ── install.md «Настройте сразу: пароль» (шаги 1–4 документа).
    await test.step('install.md: включить пароль приложения', async () => {
      await window.getByRole('link', { name: 'Настройки' }).click();
      await expect(
        window.getByRole('heading', { name: 'Защита паролем' }),
      ).toBeVisible();
      // Шаг 2: «Нажмите "Включить"» → диалог с полями и предупреждением (шаг 3).
      await window.getByTestId('security-enable').click();
      const dialog = window.getByTestId('security-dialog');
      await expect(dialog).toContainText('Включить пароль');
      await dialog.getByLabel('Новый пароль', { exact: true }).fill(APP_PASSPHRASE);
      await dialog.getByLabel('Новый пароль (ещё раз)').fill(APP_PASSPHRASE);
      // Шаг 3: галочка-гейт и «Сохранить».
      await dialog.getByLabel('Я понимаю, что без пароля данные не восстановить').check();
      await window.getByTestId('security-dialog-submit').click();
      // Обещание документа: «приложение запрашивает пароль» — статус включён.
      await expect(
        window.getByText('Вход по паролю включён — при запуске и после простоя'),
      ).toBeVisible();
    });

    // ── install.md «Настройте сразу: крупный текст» (шаги 1–2 документа).
    await test.step('install.md: крупный текст применяется сразу', async () => {
      await expect(window.getByRole('group', { name: 'Тема' })).toBeVisible();
      // exact: «Крупный» иначе матчит и «Очень крупный».
      await window.getByRole('radio', { name: 'Крупный', exact: true }).click();
      await expect(window.locator('html')).toHaveClass(/hl-text-112/);
      // Вернём «Обычный» — документ не требует, но новичок может передумать.
      await window.getByRole('radio', { name: 'Обычный', exact: true }).click();
      await expect(window.locator('html')).toHaveClass(/hl-text-100/);
    });

    // ── daily.md «Внести измерение» (шаги 1–4 документа).
    await test.step('daily.md: внести измерение кнопками-цифрами', async () => {
      await window.getByRole('link', { name: 'Журнал' }).click();
      await window.getByRole('button', { name: 'Добавить' }).first().click();
      await expect(window.getByTestId('measurement-form')).toBeVisible();
      // Шаг 2: «большими кнопками-цифрами» — 120/80; после третьей цифры
      // авто-переход в следующее поле (подсказка формы обещает это новичку).
      for (const digit of ['1', '2', '0']) {
        await window.getByRole('button', { name: `Ввести ${digit}` }).click();
      }
      for (const digit of ['8', '0']) {
        await window.getByRole('button', { name: `Ввести ${digit}` }).click();
      }
      // Шаг 4: «Нажмите "Сохранить"».
      await window.getByRole('button', { name: 'Сохранить', exact: true }).click();
      // Обещание документа: «Запись появится в истории — сегодня сверху».
      const today = window.getByText('Сегодня');
      await expect(today.first()).toBeVisible();
      await expect(window.getByText('120/80').first()).toBeVisible();
    });

    // ── data.md «Создать копию» (шаги 1–4 документа).
    await test.step('data.md: создать копию с паролем копии', async () => {
      await stubOsDialogs(app);
      const backupPath = join(tmpUserData, 'novice-backup.hlbackup');
      await app.evaluate((_, savePath) => {
        const holder = globalThis as { __hlE2eDialogState?: { savePath?: string } };
        if (holder.__hlE2eDialogState === undefined) {
          throw new Error('stubOsDialogs не вызван');
        }
        holder.__hlE2eDialogState.savePath = savePath;
      }, backupPath);

      await window.getByRole('link', { name: 'Отчёты' }).click();
      await window.getByRole('heading', { name: 'Данные' }).click();
      await window.getByTestId('data-backup-button').click();
      // Обещание документа: «Забыли пароль — данные копии невосстановимы» видно ДО.
      await expect(window.getByTestId('data-backup-forgot-warning')).toContainText(
        'Забыли пароль — данные копии невосстановимы',
      );
      await window.getByTestId('data-backup-passphrase').fill(BACKUP_PASSPHRASE);
      await window.getByTestId('data-backup-passphrase-repeat').fill(BACKUP_PASSPHRASE);
      await window.getByTestId('data-backup-submit').click();
      // Обещание документа: приложение показывает имя файла.
      await expect(window.getByTestId('data-backup-toast')).toContainText(
        'Копия сохранена: novice-backup.hlbackup',
      );
      expect(existsSync(backupPath)).toBe(true);
    });

    // ── data.md «Восстановить из копии» (шаги 1–5 документа).
    await test.step('data.md: восстановиться из копии', async () => {
      const backupPath = join(tmpUserData, 'novice-backup.hlbackup');
      await app.evaluate((_, openPaths) => {
        const holder = globalThis as { __hlE2eDialogState?: { openPaths: string[] } };
        if (holder.__hlE2eDialogState === undefined) {
          throw new Error('stubOsDialogs не вызван');
        }
        holder.__hlE2eDialogState.openPaths = openPaths;
      }, [backupPath]);

      await window.getByTestId('data-restore-button').click();
      // Шаг 2: «Выберите файл .hlbackup на диске».
      await window.getByTestId('data-restore-pick').click();
      // Шаг 3: «Введите пароль копии».
      await window.getByTestId('data-restore-passphrase').fill(BACKUP_PASSPHRASE);
      await window.getByTestId('data-restore-next').click();
      // Шаг 4: «Прочитайте план восстановления: когда создана копия и сколько
      // в ней записей» — план с датой создания и заменой.
      const plan = window.getByTestId('data-restore-plan');
      await expect(plan).toContainText('Копия создана:');
      await expect(plan).toContainText('В копии 1 запис');
      await expect(window.getByTestId('data-restore-warning-replace')).toBeVisible();
      // Шаг 5: галочка и «Восстановить».
      const execute = window.getByTestId('data-restore-execute');
      await expect(execute).toBeDisabled();
      await window.getByTestId('data-restore-confirm').check();
      await execute.click();
      // Обещание документа: «Приложение перезапустится автоматически».
      const overlay = window.getByTestId('data-restart-overlay');
      await expect(overlay).toBeVisible();
      await expect(overlay).toContainText('Приложение перезапустится');
    });

    // ── data.md «Переезд»: после перезапуска дневник на месте (запись из копии).
    await test.step('перезапуск: пароль при запуске (обещание install.md) и дневник на месте', async () => {
      await closeApp(app);
      const app2 = await launch(tmpUserData);
      const window2 = await app2.firstWindow();
      await expect(window2).toHaveTitle('Health Log');
      // Обещание install.md: «при запуске… приложение запрашивает пароль» —
      // новичок вводит записанный пароль приложения. Монтирование после запуска
      // асинхронно (гейт vault/status до роутера) — окно может подольше быть на
      // fallback «Загрузка…»; ждём дольше дефолтного 5 с.
      const lock = window2.getByTestId('lock-overlay');
      await expect(lock).toBeVisible({ timeout: 45_000 });
      await expect(lock).toContainText('Приложение заблокировано');
      await window2.getByTestId('lock-pass').fill(APP_PASSPHRASE);
      await window2.getByTestId('lock-unlock').click();
      await expect(window2.getByRole('link', { name: 'Журнал' })).toBeVisible();
      await window2.getByRole('link', { name: 'Журнал' }).click();
      await expect(window2.getByText('120/80').first()).toBeVisible();
    });
  });
});
