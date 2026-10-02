/**
 * TASK-101 §19/§24: E2E recovery — сквозной путь восстановления при повреждении
 * БД поверх ПОЛНОГО стека: dev-сборка main + dist-renderer, tmp-userData, боевая
 * крипта/ФС. Матрица (§20):
 *  (1) AC1+AC2+AC4: копия (data-care UI) → данные поверх → ПОРЧА файла БД (флип
 *      page-type байта последней страницы, прецедент container-selfcheck 100) →
 *      старт → RecoveryScreen (объяснение role=alert, БД-каналы закрыты) →
 *      техдетали с quick_check (AC4) → «Восстановить из копии» (файл-пикер →
 *      пароль → recovery-выполнение БЕЗ фазы plan) → перезапуск: в журнале данные
 *      КОПИИ (третья запись исчезла — AC2);
 *  (2) AC3: порча → RecoveryScreen → «Начать с чистого дневника» (двойное
 *      подтверждение: раскрытие + чекбокс) → перезапуск: онбординг (пустой журнал),
 *      файлы db/-wal/-shm удалены (копии/ключ НЕ тронуты — EC-14).
 *
 * ГРАНИЦА ПОДМЕН (§19 честность — прецедент data-care.spec): диалоги ОС и
 * самоперезапуск патчатся на границе electron API в main (app.evaluate); вся
 * остальная main-логика (use cases, гвардия recovery, самчек, ФС) — боевая.
 * Перезапуск эмулируется НОВЫМ launchApp на том же tmp-userData. Ассерты — по
 * data-testid (§22) и RU-текстам каталога recovery (§17).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { collectDiagnostics } from './helpers/collect-diagnostics.js';
import { closeApp, launchApp, mainProcessLogsDir } from './helpers/launch.js';
import { seedMeasurements } from './helpers/seed-measurements.js';

/** Сутки в мс и защитный сдвиг сидинга (прецедент data-care §5). */
const MS_PER_DAY = 86_400_000;
const SEED_CLOCK_GUARD_MS = 5_000;

/** Пароль копии сценария (синтетика, §14). */
const PASSPHRASE = 'пароль-копии-101';

/** Размер страницы БД (дефолт SQLite; кратность файла проверяется порчей). */
const PAGE_SIZE = 4096;

/** Мутабельная поверхность app для подавления самоперезапуска (§9 → эмуляция). */
interface MutableElectronApp {
  relaunch: () => void;
  exit: (code?: number) => void;
}

/** Фикстуры — зеркало data-care (tmp-userData + tracked launch + диагностика). */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-recovery-'));
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

/** Подмена диалогов ОС и самоперезапуска (прецедент data-care.spec §19). */
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

/** Точка сохранения следующего save-диалога (копия). */
async function setSaveDialogPath(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_, savePath) => {
    const holder = globalThis as { __hlE2eDialogState?: { savePath?: string } };
    if (holder.__hlE2eDialogState === undefined) {
      throw new Error('stubOsDialogs не вызван для этого запуска');
    }
    holder.__hlE2eDialogState.savePath = savePath;
  }, path);
}

/** Файлы следующего open-диалога (выбор копии на recovery-экране). */
async function setOpenDialogPaths(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, openPaths) => {
    const holder = globalThis as { __hlE2eDialogState?: { openPaths: string[] } };
    if (holder.__hlE2eDialogState === undefined) {
      throw new Error('stubOsDialogs не вызван для этого запуска');
    }
    holder.__hlE2eDialogState.openPaths = openPaths;
  }, paths);
}

/**
 * Порча файла БД (§19): флип первого байта последней страницы (page-type byte
 * b-tree листа — прецедент corrupt-фикстуры container-selfcheck/container-recovery):
 * открытие проходит (не заголовок), миграции не задеты — повреждение ловит
 * сампроверка старта (quick_check) → recovery-режим контейнера.
 */
function corruptLastPage(file: string): void {
  const bytes = readFileSync(file);
  expect(bytes.length % PAGE_SIZE).toBe(0);
  expect(bytes.length).toBeGreaterThan(PAGE_SIZE);
  bytes[bytes.length - PAGE_SIZE] = 0x00;
  writeFileSync(file, bytes);
}

test.describe('Recovery E2E — повреждение БД (TASK-101 §19/§24)', () => {
  test('AC1+AC2+AC4: RecoveryScreen → техдетали → восстановить из копии → данные копии', async ({
    tmpUserData,
    launch,
  }) => {
    const app1 = await launch(tmpUserData);
    const window1 = await app1.firstWindow();
    await expect(window1).toHaveTitle('Health Log');

    // arrange: копия с двумя записями (мост, §5) — они вернутся восстановлением.
    const now = Date.now();
    await seedMeasurements(window1, [
      { sys: 120, dia: 80, takenAtUtcMs: now - MS_PER_DAY - SEED_CLOCK_GUARD_MS },
      { sys: 130, dia: 85, takenAtUtcMs: now - 2 * MS_PER_DAY - SEED_CLOCK_GUARD_MS },
    ]);

    await stubOsDialogs(app1);
    await window1.getByRole('link', { name: 'Отчёты' }).click();
    const backupPath = join(tmpUserData, 'backup-recovery.hlbackup');
    await setSaveDialogPath(app1, backupPath);
    await window1.getByTestId('data-backup-button').click();
    await expect(window1.getByTestId('data-backup-forgot-warning')).toContainText('Забыли пароль');
    await window1.getByTestId('data-backup-passphrase').fill(PASSPHRASE);
    await window1.getByTestId('data-backup-passphrase-repeat').fill(PASSPHRASE);
    await window1.getByTestId('data-backup-submit').click();
    await expect(window1.getByTestId('data-backup-toast')).toContainText('Копия сохранена');
    expect(existsSync(backupPath)).toBe(true);

    // Данные поверх копии: сейчас 3 записи, в копии — 2.
    await seedMeasurements(window1, [
      { sys: 140, dia: 90, takenAtUtcMs: now - SEED_CLOCK_GUARD_MS },
    ]);
    await closeApp(app1);

    // Порча БД → старт №2: RecoveryScreen вместо контента (AC1).
    corruptLastPage(join(tmpUserData, 'health-log.db'));
    const app2 = await launch(tmpUserData);
    const window2 = await app2.firstWindow();
    await expect(window2).toHaveTitle('Health Log');
    await expect(window2.getByTestId('recovery-screen')).toBeVisible();
    const explain = window2.getByTestId('recovery-explain');
    await expect(explain).toBeVisible();
    await expect(explain).toContainText('резервной копии');

    // Технические детали раскрываются: вывод quick_check виден (AC4).
    await window2.getByText('Технические детали').click();
    await expect(window2.getByTestId('recovery-details-text')).toContainText('database');

    // «Восстановить из копии»: пикер → пароль → recovery-выполнение → рестарт.
    await stubOsDialogs(app2);
    await setOpenDialogPaths(app2, [backupPath]);
    await window2.getByTestId('recovery-restore-pick').click();
    await expect(window2.getByTestId('recovery-restore-picked')).toContainText(
      'backup-recovery.hlbackup',
    );
    await window2.getByTestId('recovery-restore-pass').fill(PASSPHRASE);
    await window2.getByTestId('recovery-restore-submit').click();
    await expect(window2.getByTestId('recovery-restart-note')).toBeVisible();

    // Перезапуск (эмуляция): в журнале данные КОПИИ — 120/80 и 130/85, без 140/90 (AC2).
    await closeApp(app2);
    const app3 = await launch(tmpUserData);
    const window3 = await app3.firstWindow();
    await expect(window3).toHaveTitle('Health Log');
    await expect(window3.getByTestId('recovery-screen')).toHaveCount(0);
    await window3.getByRole('link', { name: 'Журнал' }).click();
    await expect(window3.getByTestId('measurement-row').filter({ hasText: '140/90' })).toHaveCount(
      0,
    );
    await expect(
      window3.getByTestId('measurement-row').filter({ hasText: '120/80' }),
    ).toBeVisible();
    await expect(
      window3.getByTestId('measurement-row').filter({ hasText: '130/85' }),
    ).toBeVisible();
  });

  test('AC3: начать заново → двойное подтверждение → онбординг, копии не тронуты', async ({
    tmpUserData,
    launch,
  }) => {
    const app1 = await launch(tmpUserData);
    const window1 = await app1.firstWindow();
    await expect(window1).toHaveTitle('Health Log');

    // arrange: одна запись + внешняя копия на диске (EC-14: «начать заново» её НЕ трогает).
    await seedMeasurements(window1, [
      { sys: 125, dia: 85, takenAtUtcMs: Date.now() - SEED_CLOCK_GUARD_MS },
    ]);
    const backupPath = join(tmpUserData, 'keep-me.hlbackup');
    const backupContent = 'внешняя копия пользователя';
    await writeFile(backupPath, backupContent, 'utf8');
    await closeApp(app1);

    // Порча → RecoveryScreen → «Начать заново».
    corruptLastPage(join(tmpUserData, 'health-log.db'));
    const app2 = await launch(tmpUserData);
    const window2 = await app2.firstWindow();
    await expect(window2).toHaveTitle('Health Log');
    await expect(window2.getByTestId('recovery-screen')).toBeVisible();
    // Самоперезапуск подавляется и здесь (диалогов discard не использует, §9).
    await stubOsDialogs(app2);

    // Двойное подтверждение (§13): раскрытие → чекбокс-фраза → гейт кнопки.
    await window2.getByTestId('recovery-discard-open').click();
    const execute = window2.getByTestId('recovery-discard-execute');
    await expect(execute).toBeDisabled();
    await window2.getByTestId('recovery-discard-checkbox').check();
    await execute.click();
    await expect(window2.getByTestId('recovery-restart-note')).toBeVisible();

    // Файлы db/-wal/-shm удалены (на диске — после закрытия соединения).
    await closeApp(app2);
    expect(existsSync(join(tmpUserData, 'health-log.db'))).toBe(false);
    // Копия пользователя осталась (EC-14) — восстановление остаётся возможным.
    expect(existsSync(backupPath)).toBe(true);

    // Перезапуск (эмуляция): онбординг — журнал пуст, «как после установки».
    const app3 = await launch(tmpUserData);
    const window3 = await app3.firstWindow();
    await expect(window3).toHaveTitle('Health Log');
    await window3.getByRole('link', { name: 'Журнал' }).click();
    await expect(window3.getByTestId('empty-history')).toBeVisible();
    await expect(window3.getByText('Пока нет измерений')).toBeVisible();
  });
});
