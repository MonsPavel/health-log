/**
 * TASK-081 §19/§20 (AC6): e2e витрины моделей — «dev-модель скачать → выбрать →
 * статус выбранной» на реальном приложении (dev-сборка main + dist-renderer):
 *  (1) /ai: баннер «ИИ не настроен», карточка dev-модели (not_installed);
 *  (2) «Скачать» → согласие-диалог (§14: host из URL манифеста) → «Разрешить и
 *      скачать» → TEST-INSTALL (§22, HL_TEST_MODEL_FILE — файл ставится мимо сети:
 *      PLACEHOLDER-URL манифеста сетевой путь 080 не проходит) → карточка installed;
 *  (3) «Выбрать» → бейдж «Выбрана» (prefs.aiSettings.modelId, §9); файл модели на
 *      месте в <userData>/models (изоляция данных tmp-userData, §14).
 *
 * Сеть не используется вовсе: согласие перехватывает UI, установка — тест-хук §22.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';

const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string, fakeModelPath: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-models-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  launch: async ({}, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (userData: string, fakeModelPath: string) => {
      const app = await launchApp({ userData, fakeLlm: true, testModelFile: fakeModelPath });
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      await closeApp(app).catch(() => undefined);
    }
  },
});

test.describe('витрина моделей (TASK-081 §20 AC6)', () => {
  test('dev-модель: скачать (с согласия, мимо сети §22) → выбрать → статус выбранной', async ({
    tmpUserData,
    launch,
  }) => {
    // Локальный файл «модели» — источник TEST-INSTALL (содержимое произвольно).
    const fakeModelPath = join(tmpUserData, 'fake-source.gguf');
    await writeFile(fakeModelPath, 'fake-gguf-bytes');

    const app = await launch(tmpUserData, fakeModelPath);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // (1) /ai: навигация как пользователь — ссылка «ИИ» в sidebar (прецедент
    // critical-path.spec.ts); баннер онбординга + карточка not_installed.
    await window.getByRole('link', { name: 'ИИ' }).click();
    await expect(window.getByTestId('ai-banner')).toBeVisible();
    const card = window.getByTestId('model-card');
    await expect(card).toBeVisible();
    await expect(window.getByTestId('model-name')).toHaveText('Dev Placeholder Model');
    const download = window.getByTestId('model-download');
    await expect(download).toHaveText('Скачать');

    // (2) Первый «Скачать» → согласие-диалог ДО сети (§14); host — из URL манифеста.
    await download.click();
    const dialog = window.getByTestId('consent-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('placeholder.invalid');

    // Подтверждение → prefs/set согласия → download (TEST-INSTALL §22) → installed.
    await window.getByTestId('consent-confirm').click();
    await expect(window.getByTestId('model-select')).toHaveText('Выбрать');
    // Файл установлен в <userData>/models под именем дескриптора (§22).
    expect(existsSync(join(tmpUserData, 'models', 'dev-placeholder.gguf'))).toBe(true);

    // (3) «Выбрать» → бейдж «Выбрана» (prefs.aiSettings.modelId через prefs/set §9).
    await window.getByTestId('model-select').click();
    await expect(window.getByTestId('model-selected-badge')).toHaveText('Выбрана');
    await expect(window.getByTestId('model-select')).toHaveCount(0);
  });
});
