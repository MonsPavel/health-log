/**
 * TASK-113 §5/§19/§20: E2E руководства пользователя docs/user.
 *
 * Два сценария разной «постоянности»:
 *  1. «Помощь» e2e-мини (AC §20) — БЕЗ гарда: в обычных прогонах `pnpm test:e2e`.
 *     Кнопка секции «Помощь» вызывает канал `app/open-docs {page:'index'}` —
 *     конверт ok (main нашёл локальный файл или ушёл в репозиторий; fire-and-
 *     forget §9: конверт всегда ok null — отказ открытия глушится warn-ом).
 *  2. Генератор скриншотов — ТОЛЬКО явно: `HL_DOCS_SHOTS=1 pnpm --filter
 *     @hl/desktop exec playwright test user-docs-screenshots` после `pnpm build`
 *     (нужен dist/main + dist-renderer). В обычных прогонах пропускается.
 *
 * ДАННЫЕ — ТОЛЬКО СИНТЕТИКА (§20 AC-5): tmp-userData изоляция + ~2 недели
 * фиксированных значений через РЕАЛЬНЫЙ мост (helpers/seed-measurements, §14:
 * не пользовательские данные). Скриншоты пишутся сразу в docs/user/img — это
 * репо-ассеты руководства; alt-тексты живут в самих .md-страницах (§16).
 *
 * §22 (устаревание доков): правка UX экрана → перегенерация затронутых снимков
 * этим же спеком (правило DoD — CONTRIBUTING §7).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  test as base,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';
import { seedMeasurements } from './helpers/seed-measurements.js';

/** docs/user/img от этого файла: tests/e2e → apps/desktop → apps → корень репо. */
const DOCS_IMG_DIR = join(
  fileURLToPath(new URL('../../../..', import.meta.url)),
  'docs',
  'user',
  'img',
);

/** Фикстуры (прецедент critical-path.spec.ts): tmp-userData + страховка закрытия. */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-docs-'));
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

async function goto(window: Page, nav: string, ready: () => Locator): Promise<void> {
  await window.getByRole('link', { name: nav }).click();
  await expect(ready().first()).toBeVisible();
}

test.describe('«Помощь» открывает руководство — e2e-мини (TASK-113 §20 AC)', () => {
  test('секция «Помощь» в настройках: клик → app/open-docs {page:"index"} → конверт ok', async ({
    tmpUserData,
    launch,
  }) => {
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // §5: «index.md — оглавление + линк из настроек»: секция в DOM, кнопка на месте.
    await goto(window, 'Настройки', () => window.getByTestId('help-section'));
    await expect(window.getByRole('heading', { name: 'Помощь' })).toBeVisible();
    await expect(window.getByTestId('help-open')).toBeEnabled();

    // Клик как пользователь: alert-ошибки быть не должно — канал fire-and-forget.
    await window.getByTestId('help-open').click();
    await expect(window.getByTestId('help-error')).toHaveCount(0);

    // Прямой вызов моста: конверт ok (main открыл локальный файл/репозиторий).
    const envelope = await window.evaluate(async () => {
      const bridge = (
        globalThis as {
          hl?: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
        }
      ).hl;
      if (bridge === undefined) {
        throw new Error('preload-мост window.hl недоступен');
      }
      return (await bridge.invoke('app/open-docs', { page: 'index' })) as { ok?: boolean };
    });
    expect(envelope.ok).toBe(true);
  });
});

test.describe('скриншоты руководства docs/user (TASK-113 §5)', () => {
  // Гард: генерация запускается только по явной команде (см. шапку).
  test.skip(
    process.env['HL_DOCS_SHOTS'] !== '1',
    'генерация скриншотов docs/user — HL_DOCS_SHOTS=1',
  );

  /**
   * Синтетика ~2 недель: утро/вечер, стабильные значения с лёгким дрейфом —
   * картина обычного дневника без критических отметок (§14: не пользовательские).
   */
  async function seedSyntheticHistory(window: Page): Promise<void> {
    const hour = 3_600_000;
    const now = Date.now();
    const entries: Array<{ sys: number; dia: number; takenAtUtcMs: number }> = [];
    const morning = [126, 131, 128, 133, 129, 127, 130, 125, 129, 132, 128, 127, 130, 126];
    const evening = [121, 126, 123, 128, 124, 122, 125, 120, 124, 127, 123, 122, 125, 121];
    for (let day = 13; day >= 0; day -= 1) {
      const morningSys = morning[13 - day] ?? 128;
      const eveningSys = evening[13 - day] ?? 124;
      entries.push({
        sys: morningSys,
        dia: morningSys - 48,
        takenAtUtcMs: now - day * 24 * hour - 10 * hour,
      });
      entries.push({
        sys: eveningSys,
        dia: eveningSys - 47,
        takenAtUtcMs: now - day * 24 * hour - 1 * hour,
      });
    }
    await seedMeasurements(window, entries);
  }

  const shot = (name: string, locator: Locator) =>
    locator.screenshot({ path: join(DOCS_IMG_DIR, name), animations: 'disabled' });

  test('семь снимков на синтетике: форма, журнал, динамика, ИИ, данные, приватность, пароль', async ({
    tmpUserData,
    launch,
  }) => {
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');
    await mkdir(DOCS_IMG_DIR, { recursive: true });

    // Синтетическая история — реальным мостом (§5 helpers/seed-measurements).
    await seedSyntheticHistory(window);

    // 1. Динамика (daily.md): сводка с графиком — после сидинга данные есть.
    await goto(window, 'Динамика', () => window.getByTestId('trend-chart'));
    await window.waitForTimeout(600); // дорисовка анимации графика recharts
    await shot('dashboard-trend.png', window.locator('body'));

    // 2. Журнал — история с фильтрами (daily.md).
    await goto(window, 'Журнал', () => window.getByTestId('day-group'));
    await shot('journal-history.png', window.locator('body'));

    // 3. Форма измерения с кнопками-цифрами (daily.md): «Добавить» в истории.
    await window.getByRole('button', { name: 'Добавить' }).first().click();
    await expect(window.getByTestId('measurement-form')).toBeVisible();
    await shot('measurement-form.png', window.getByTestId('measurement-form'));

    // 4. ИИ — вкладка «Модель»: карточки моделей без загрузки (ai.md).
    await goto(window, 'ИИ', () => window.getByTestId('insight-screen'));
    await window.getByTestId('ai-tab-model').click();
    await expect(window.getByTestId('ai-models-section')).toBeVisible();
    await shot('ai-models.png', window.getByTestId('ai-models-section'));

    // 5. Отчёты → секция «Данные» (data.md).
    await goto(window, 'Отчёты', () => window.getByTestId('data-care'));
    await shot('data-care.png', window.getByTestId('data-care'));

    // 6–7. Настройки: «Приватность» (privacy.md) и «Защита паролем» (install.md).
    await goto(window, 'Настройки', () => window.getByTestId('privacy-section'));
    await shot('privacy.png', window.getByTestId('privacy-section'));
    await shot('security-password.png', window.getByTestId('security-section'));
  });
});
