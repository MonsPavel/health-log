/**
 * TASK-057 §20.1 (ревью): подпись источника шкалы на «Динамике» видна В РЕАЛЬНОМ
 * движке (Chromium/Electron) и вне <svg>. Мотивация: Recharts 3.10 монтирует
 * детей ComposedChart внутрь <svg> — HTML-элемент в svg не рендерится
 * (getBoundingClientRect 0×0, offsetParent null) и не попадает в
 * accessibility-дерево; jsdom этого не ловит (узел есть в DOM-дереве). Компонентные
 * тесты проверяют размещение узла (не svg / не aria-hidden), этот спек — фактический
 * рендер: измерение через форму → график с 4 опорными линиями + подпись с
 * ненулевым прямоугольником.
 *
 * Никаких sleep — auto-waiting Playwright (§13); данные — синтетические 125/82 (§14).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';

/** Фикстуры (прецедент visual-scales.spec): tmp-userData + tracked-launch. */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-caption-'));
    await use(dir);
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
      await closeApp(app).catch(() => undefined);
    }
  },
});

test.describe('подпись источника шкалы рендерится (TASK-057 §20.1, ревью)', () => {
  test('измерение 125/82 → «Динамика»: caption вне svg с ненулевым rect, 4 опорные линии', async ({
    tmpUserData,
    launch,
  }) => {
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // Одно измерение через форму (прецедент critical-path.spec, минимум полей).
    await window.getByRole('link', { name: 'Журнал' }).click();
    await window.getByTestId('empty-history').getByRole('button').click();
    for (const digit of ['1', '2', '5']) {
      await window.getByRole('button', { name: `Ввести ${digit}` }).click();
    }
    const diaInput = window.getByTestId('input-dia');
    await diaInput.click();
    await window.keyboard.press('8');
    await window.keyboard.press('2');
    await diaInput.press('Enter');
    await expect(window.getByTestId('confirm-flags-dialog')).toHaveCount(0);
    // Запись сохранена (прецедент critical-path §5 шаг 4): иначе график пуст.
    await expect(window.getByTestId('measurement-row').filter({ hasText: '125/82' })).toBeVisible();

    // «Динамика»: график с данными (raw, 1 точка) — caption и линии.
    await window.getByRole('link', { name: 'Динамика' }).click();
    await expect(window.getByTestId('trend-chart')).toBeVisible();

    // §20.1: подпись «ESC/ESH 2018» ВИДНА — ненулевой прямоугольник в реальном
    // движке (toBeVisible = непустой bounding box; HTML внутри svg давал бы 0×0 —
    // проба ревью в Chromium) и ровно один узел, ВНЕ <svg>.
    const caption = window.getByTestId('scale-source');
    await expect(caption).toBeVisible();
    await expect(caption).toContainText('ESC/ESH 2018');
    const captionBox = await caption.boundingBox();
    expect(captionBox).not.toBeNull();
    expect(captionBox?.width ?? 0).toBeGreaterThan(0);
    expect(captionBox?.height ?? 0).toBeGreaterThan(0);
    await expect(window.locator('svg [data-testid="scale-source"]')).toHaveCount(0);
    await expect(window.locator('[data-testid="scale-source"]')).toHaveCount(1);

    // 4 опорные линии (2 sys + 2 dia) — в svg, где им место.
    await expect(window.locator('.recharts-reference-line')).toHaveCount(4);
  });
});
