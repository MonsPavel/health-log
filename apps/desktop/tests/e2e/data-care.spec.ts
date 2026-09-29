/**
 * TASK-043 §2/§5 (стиль) + TASK-073 §19/§24: E2E Data Care — сквозные UC-08/UC-10
 * поверх ПОЛНОГО стека: dev-сборка main + dist-renderer, tmp-userData, use cases
 * 070/071/072 с РЕАЛЬНОЙ криптой (argon2+GCM), реальной заменой/удалением файлов.
 *
 * Два сценария §19:
 *  (1) UC-08 полный: копия (диалог пароля ×2, обязательное предупреждение «Забыли
 *      пароль», тост с именем, файл на диске) → добавить данные поверх копии →
 *      восстановить (файл-пикер → пароль → план «В копии 2 записей, сейчас — 3» →
 *      чекбокс-гейт → execute → рестарт-экран) → перезапуск: в журнале данные
 *      КОПИИ (третья запись исчезла, AC-2);
 *  (2) UC-10: план удаления (счётчик, категории с копиями, localStorage) →
 *      «Сначала экспортировать» работает (файл на диске) → чекбокс-гейт → execute →
 *      рестарт-экран + localStorage hl.* очищен (§10 072) + файлы БД/ключа удалены →
 *      перезапуск: онбординг (пустой журнал).
 *
 * ГРАНИЦА ПОДМЕН (§19 честность): диалоги ОС автоматизировать нельзя —
 * dialog.showSaveDialog/showOpenDialog патчатся на границе electron API в MAIN
 * (app.evaluate), вся остальная main-логика (use cases, очередь, шифрование,
 * файловая система) — боевая. Самоперезапуск (§9 071/072: relaunch+exit через
 * 500 мс) подавлен там же: перезапущенный инстанс не прикрепляется к Playwright и
 * держал бы single-instance lock, поэтому перезапуск эмулируется НОВЫМ launchApp
 * на том же tmp-userData — путь данных (замена/удаление файлов на диске) остаётся
 * реальным. Восстановление ассертов рандомных дат — по подстрокам каталога ru (§17).
 *
 * Ассерты по RU-текстам каталога (§17) и data-testid (§22); изоляция — tmp-userData
 * fixture (прецедент critical-path/edge-inputs); при падении — диагностика (§19).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { collectDiagnostics } from './helpers/collect-diagnostics.js';
import { closeApp, launchApp, mainProcessLogsDir } from './helpers/launch.js';
import { seedMeasurements } from './helpers/seed-measurements.js';

/** Сутки в мс и защитный сдвиг сидинга (прецедент edge-inputs §5). */
const MS_PER_DAY = 86_400_000;
const SEED_CLOCK_GUARD_MS = 5_000;

/** Пароль копии сценария UC-08 (синтетика, §14). */
const PASSPHRASE = 'пароль-копии-073';

/** Мутабельная поверхность app для подавления самоперезапуска (§9 → эмуляция). */
interface MutableElectronApp {
  relaunch: () => void;
  exit: (code?: number) => void;
}

/** Фикстуры — зеркало critical-path/edge-inputs (tmp-userData + tracked launch). */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-data-care-'));
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
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      // Черновик формы (localStorage) общий для прогонов — чистим до quit
      // (прецедент edge-inputs, §20 повторный прогон).
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

/**
 * Подмена диалогов ОС на границе electron API в main + подавление самоперезапуска
 * (см. шапку). Состояние (путь save/список open) живёт в globalThis main-процесса и
 * меняется из теста точечными evaluate (setSaveDialogPath/setOpenDialogPaths).
 */
async function stubOsDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, app: electronApp }) => {
    const state: { savePath?: string; openPaths: string[] } = { openPaths: [] };
    (globalThis as { __hlE2eDialogState?: unknown }).__hlE2eDialogState = state;
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () =>
      state.savePath === undefined
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePath: state.savePath };
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () =>
      state.openPaths.length === 0
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: state.openPaths };
    (electronApp as unknown as MutableElectronApp).relaunch = () => undefined;
    (electronApp as unknown as MutableElectronApp).exit = () => undefined;
  });
}

/** Точка сохранения следующего save-диалога main (копия/экспорт). */
async function setSaveDialogPath(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_, savePath) => {
    const holder = globalThis as { __hlE2eDialogState?: { savePath?: string } };
    if (holder.__hlE2eDialogState === undefined) {
      throw new Error('stubOsDialogs не вызван для этого запуска');
    }
    holder.__hlE2eDialogState.savePath = savePath;
  }, path);
}

/** Файлы следующего open-диалога main (выбор копии для восстановления). */
async function setOpenDialogPaths(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, openPaths) => {
    const holder = globalThis as { __hlE2eDialogState?: { openPaths: string[] } };
    if (holder.__hlE2eDialogState === undefined) {
      throw new Error('stubOsDialogs не вызван для этого запуска');
    }
    holder.__hlE2eDialogState.openPaths = openPaths;
  }, paths);
}

test.describe('Data Care E2E — UC-08/UC-10 (TASK-073 §19)', () => {
  test('UC-08: копия → добавить данные → восстановить → данные копии', async ({
    tmpUserData,
    launch,
  }) => {
    const app1 = await launch(tmpUserData);
    const window1 = await app1.firstWindow();
    await expect(window1).toHaveTitle('Health Log');

    // arrange: две записи (мост, §5 edge-inputs) — они уйдут в копию.
    const now = Date.now();
    await seedMeasurements(window1, [
      { sys: 120, dia: 80, takenAtUtcMs: now - MS_PER_DAY - SEED_CLOCK_GUARD_MS },
      { sys: 130, dia: 85, takenAtUtcMs: now - 2 * MS_PER_DAY - SEED_CLOCK_GUARD_MS },
    ]);

    await stubOsDialogs(app1);
    await window1.getByRole('link', { name: 'Отчёты' }).click();

    // (1) Создать копию: диалог пароля с обязательным предупреждением (§14).
    const backupPath = join(tmpUserData, 'backup-uc08.hlbackup');
    await setSaveDialogPath(app1, backupPath);
    await window1.getByTestId('data-backup-button').click();
    await expect(window1.getByTestId('data-backup-forgot-warning')).toContainText('Забыли пароль');
    await window1.getByTestId('data-backup-passphrase').fill(PASSPHRASE);
    await window1.getByTestId('data-backup-passphrase-repeat').fill(PASSPHRASE);
    await window1.getByTestId('data-backup-submit').click();
    await expect(window1.getByTestId('data-backup-toast')).toContainText(
      'Копия сохранена: backup-uc08.hlbackup',
    );
    expect(existsSync(backupPath)).toBe(true);

    // (2) Данные поверх копии: сейчас 3 записи, в копии — 2.
    await seedMeasurements(window1, [
      { sys: 140, dia: 90, takenAtUtcMs: now - SEED_CLOCK_GUARD_MS },
    ]);

    // (3) Восстановление: файл-пикер → пароль → план → чекбокс-гейт → execute.
    await setOpenDialogPaths(app1, [backupPath]);
    await window1.getByTestId('data-restore-button').click();
    await window1.getByTestId('data-restore-pick').click();
    const passphraseInput = window1.getByTestId('data-restore-passphrase');
    await expect(passphraseInput).toHaveValue(''); // предзаполнения нет (§13)
    await passphraseInput.fill(PASSPHRASE);
    await window1.getByTestId('data-restore-next').click();

    const plan = window1.getByTestId('data-restore-plan');
    await expect(plan).toContainText('В копии 2 записей, сейчас — 3');
    await expect(window1.getByTestId('data-restore-warning-replace')).toBeVisible();
    const execute = window1.getByTestId('data-restore-execute');
    await expect(execute).toBeDisabled(); // чекбокс-гейт (§13 — защита от Enter-спама)
    await window1.getByTestId('data-restore-confirm').check();
    await expect(execute).toBeEnabled();
    await execute.click();

    const overlay = window1.getByTestId('data-restart-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Приложение перезапустится');

    // (4) Перезапуск (эмуляция — см. шапку): данные КОПИИ в журнале (AC-2).
    await closeApp(app1);
    const app2 = await launch(tmpUserData);
    const window2 = await app2.firstWindow();
    await expect(window2).toHaveTitle('Health Log');
    await window2.getByRole('link', { name: 'Журнал' }).click();
    await expect(
      window2.getByTestId('measurement-row').filter({ hasText: '140/90' }),
    ).toHaveCount(0);
    await expect(
      window2.getByTestId('measurement-row').filter({ hasText: '120/80' }),
    ).toBeVisible();
    await expect(
      window2.getByTestId('measurement-row').filter({ hasText: '130/85' }),
    ).toBeVisible();
  });

  test('UC-10: удалить все данные → экспорт-ссылка → чекбокс → онбординг', async ({
    tmpUserData,
    launch,
  }) => {
    const app1 = await launch(tmpUserData);
    const window1 = await app1.firstWindow();
    await expect(window1).toHaveTitle('Health Log');

    // arrange: одна запись + черновик localStorage (что удалится — §10 072).
    await seedMeasurements(window1, [
      { sys: 125, dia: 85, takenAtUtcMs: Date.now() - SEED_CLOCK_GUARD_MS },
    ]);
    await window1.evaluate(() => {
      window.localStorage.setItem('hl.formDraft', 'черновик сценария');
    });

    await stubOsDialogs(app1);
    const exportPath = join(tmpUserData, 'export-before-wipe.json');
    await setSaveDialogPath(app1, exportPath);
    await window1.getByRole('link', { name: 'Отчёты' }).click();

    // (1) План: счётчик, категории (включая копии), пункт localStorage.
    await window1.getByTestId('data-wipe-button').click();
    const plan = window1.getByTestId('data-wipe-plan');
    await expect(plan).toContainText('Измерений к удалению: 1');
    await expect(window1.getByTestId('data-wipe-categories')).toContainText(
      'База данных измерений',
    );
    await expect(window1.getByTestId('data-wipe-categories')).toContainText('Локальные копии');
    await expect(plan).toContainText('Черновики и локальные настройки');

    // (2) «Сначала экспортировать» работает (AC4): файл на диске, инлайн-подтверждение.
    await window1.getByTestId('data-wipe-export').click();
    await expect(window1.getByTestId('data-wipe-export-notice')).toContainText(
      'Экспорт сохранён: export-before-wipe.json',
    );
    expect(existsSync(exportPath)).toBe(true);

    // (3) Чекбокс-гейт → execute → рестарт-экран; localStorage hl.* очищен (§10 072).
    const execute = window1.getByTestId('data-wipe-execute');
    await expect(execute).toBeDisabled();
    await window1.getByTestId('data-wipe-confirm').check();
    await execute.click();
    await expect(window1.getByTestId('data-restart-overlay')).toContainText('Данные удалены');
    const hlKeys = await window1.evaluate(() =>
      Object.keys(window.localStorage).filter((key) => key.startsWith('hl.')),
    );
    expect(hlKeys).toEqual([]);
    // Файлы данных удалены (БД и ключ; -wal/-shm закрываются вместе с соединением).
    expect(existsSync(join(tmpUserData, 'health-log.db'))).toBe(false);
    expect(existsSync(join(tmpUserData, 'vault.key'))).toBe(false);

    // (4) Перезапуск (эмуляция): онбординг — журнал пуст, «как после установки».
    await closeApp(app1);
    const app2 = await launch(tmpUserData);
    const window2 = await app2.firstWindow();
    await expect(window2).toHaveTitle('Health Log');
    await window2.getByRole('link', { name: 'Журнал' }).click();
    await expect(window2.getByTestId('empty-history')).toBeVisible();
    await expect(window2.getByText('Пока нет измерений')).toBeVisible();
  });
});
