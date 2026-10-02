/**
 * TASK-048 §5/§19/§20: visual-матрица крупного режима текста — 5 маршрутов ×
 * 3 масштаба (100 / 112.5 / 125) × 2 темы = 30 снапшотов (порог pixelmatch
 * maxDiffPixelRatio 0.1; базлайны коммитятся — tests/e2e/__screenshots__, §6;
 * путь фиксирует snapshotPathTemplate в playwright.config).
 *
 * Механика: приложение на пустой tmp-userData (детерминированные пустые состояния,
 * §14). Тема и масштаб применяются как пользователем — кликами по сегментам
 * «Настроек» (AppearanceSection): мутация prefs/set optimistic (§10 TASK-047)
 * применяет data-theme и класс hl-text-* на <html> мгновенно (AC-1), персистентность
 * — БД. Снапшот снимается только после появления признаков на <html> и контента
 * маршрута. Прямой prefs/set из evaluate здесь НЕ используется: шина событий main
 * (prefs:changed) в окно не бродкастится (wiring broadcast — вне §5 задачи), и
 * рендерер узнал бы о смене только при следующем prefs/get.
 *
 * Аудит вёрстки (§13/AC-3): снапшоты на «очень крупном» фиксируют, что ничего
 * не обрезано и не перекрыто — визуальная ревизия 5 маршрутов. AC-4 дополнительно
 * замеряет bounding box цифровых кнопок формы на масштабе 125 (≥44px — цель
 * нажатия NFR-6, кнопки rem — растут с масштабом).
 *
 * Риски хрупкости (§22): шрифты ОС — базлайны Windows (локальный рендер, §19);
 * анимации отключены опцией screenshot (animate-pulse и пр.). TASK-061: /dashboard —
 * домашняя сводка; на пустой БД — приветственное состояние (маркер dashboard-welcome),
 * базлайны маршрута перегенерированы. TASK-099: /settings получил секцию
 * «Приватность» (страница скроллится) — снапшот маршрута снят как fullPage
 * (иначе новая секция ниже фолда не верифицируется вовсе), базлайны маршрута
 * перегенерированы. TASK-100: /settings получил секцию «О приложении» (версии,
 * статус сампроверки, полная проверка БД — AC3 «все версии видны» скриншотом);
 * динамические строки секции (время проверки, мс старта) — единицы символов,
 * порог 0.1 поглощает; базлайны маршрута перегенерированы.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';

/** Пресеты масштаба: подпись сегмента → класс на <html> (§5; каталог settings). */
const SCALES = [
  { label: 'Обычный', cls: 'hl-text-100' },
  { label: 'Крупный', cls: 'hl-text-112' },
  { label: 'Очень крупный', cls: 'hl-text-125' },
] as const;

/** Темы: подпись сегмента → значение data-theme. */
const THEMES = [
  { label: 'Светлая', value: 'light' },
  { label: 'Тёмная', value: 'dark' },
] as const;

/** Порог диффа снапшота (§19: pixelmatch 0.1). */
const MAX_DIFF_RATIO = 0.1;

/** Маршруты матрицы (порядок навигации; /settings — последним, после выбора). */
const ROUTES = ['/dashboard', '/journal', '/ai', '/reports', '/settings'] as const;

/** Подпись раздела навигации по маршруту (common.json §17). */
function labelOf(path: string): string {
  switch (path) {
    case '/dashboard':
      return 'Динамика';
    case '/journal':
      return 'Журнал';
    case '/ai':
      return 'ИИ';
    case '/reports':
      return 'Отчёты';
    case '/settings':
      return 'Настройки';
    default:
      throw new Error(`неизвестный маршрут матрицы: ${path}`);
  }
}

/** Детерминированный признак готовности контента маршрута (§19: без sleep). */
function readyLocator(window: Page, path: string): Locator {
  switch (path) {
    case '/dashboard':
      // TASK-061: /dashboard — домашний экран-сводка; на пустой tmp-userData
      // measurements/list {limit:1} отвечает total 0 — детерминированное
      // приветственное состояние «Начните дневник» (карточек и графика нет).
      return window.getByTestId('dashboard-welcome');
    case '/journal':
      return window.getByTestId('empty-history');
    case '/ai':
      // TASK-088 §6: вкладка «Разбор» — содержательный маркер экрана (заголовок
      // «ИИ» перестал быть уникальным — внутри вкладки есть «Что передаётся ИИ»).
      return window.getByTestId('insight-screen');
    case '/reports':
      return window.getByRole('heading', { name: 'Отчёты' });
    case '/settings':
      return window.getByRole('group', { name: 'Тема' });
    default:
      throw new Error(`неизвестный маршрут матрицы: ${path}`);
  }
}

/** Фикстуры (прецедент critical-path.spec.ts): tmp-userData + страховка закрытия. */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-scales-'));
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

/**
 * Применение темы и масштаба как пользователь (§20 AC-1): в «Настройках» клики по
 * сегментам; мутация prefs/set optimistic применяет признаки на <html> мгновенно —
 * их и ждём (data-theme = значение темы, класс hl-text-* = масштаб).
 */
async function applyAppearanceViaSettings(
  window: Page,
  theme: (typeof THEMES)[number],
  scale: (typeof SCALES)[number],
): Promise<void> {
  await window.getByRole('link', { name: 'Настройки' }).click();
  const themeGroup = window.getByRole('group', { name: 'Тема' });
  await expect(themeGroup).toBeVisible();
  // Контролы выключены, пока prefs не загружены (§10 TASK-047) — ждём включения.
  await expect(window.getByRole('radio', { name: 'Обычный' })).toBeEnabled();

  // exact: true — «Крупный» иначе матчит и «Очень крупный» (substring-семантика).
  await window.getByRole('radio', { name: theme.label, exact: true }).click();
  await window.getByRole('radio', { name: scale.label, exact: true }).click();

  await expect(window.locator('html')).toHaveAttribute('data-theme', theme.value);
  await expect(window.locator('html')).toHaveClass(new RegExp(scale.cls));
}

test.describe('visual-матрица масштабов текста (TASK-048 §19/§20)', () => {
  for (const theme of THEMES) {
    for (const scale of SCALES) {
      test(`масштаб «${scale.label}» × ${theme.value}: 5 маршрутов без обрезок и перекрытий`, async ({
        tmpUserData,
        launch,
      }) => {
        const app = await launch(tmpUserData);
        const window = await app.firstWindow();
        await expect(window).toHaveTitle('Health Log');

        await applyAppearanceViaSettings(window, theme, scale);

        for (const route of ROUTES) {
          await test.step(route, async () => {
            await window.getByRole('link', { name: labelOf(route) }).click();
            await expect(readyLocator(window, route)).toBeVisible();
            await expect(window).toHaveScreenshot(screenshotName(route, theme, scale), {
              animations: 'disabled',
              maxDiffPixelRatio: MAX_DIFF_RATIO,
              // TASK-099: /settings скроллится (секция «Приватность») — fullPage,
              // иначе всё ниже фолда выпадает из верификации (§13 TASK-048).
              ...(route === '/settings' ? { fullPage: true } : {}),
            });
          });
        }
      });
    }
  }

  test('AC-4: на «очень крупном» (125) цифровые кнопки формы ≥44px (bounding box)', async ({
    tmpUserData,
    launch,
  }) => {
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // Пресеты матрицы фиксированы: индексы 2 (125%) и 0 (light) существуют всегда.
    await applyAppearanceViaSettings(window, THEMES[0], SCALES[2]);

    await window.getByRole('link', { name: 'Журнал' }).click();
    const empty = window.getByTestId('empty-history');
    await expect(empty).toBeVisible();
    // CTA пустого состояния (в header журнала есть одноимённая кнопка — сужаем).
    await empty.getByRole('button', { name: 'Добавить' }).click();

    // Цель нажатия ≥44px в CSS-пикселях (NFR-6/§13-5): rem-кнопки РАСТУТ с
    // масштабом — на 125% min-размер 2.75rem × 1.25 = 55px, порог 44 — минимум.
    const digit = window.getByRole('button', { name: 'Ввести 5' });
    await expect(digit).toBeVisible();
    const box = await digit.boundingBox();
    expect(box, 'bounding box цифровой кнопки').not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  });
});

/** Имя снапшота матрицы: scales-<маршрут>-<тема>-<масштаб>.png (без точки). */
function screenshotName(
  route: (typeof ROUTES)[number],
  theme: (typeof THEMES)[number],
  scale: (typeof SCALES)[number],
): string {
  const scaleKey = scale.cls.replace('hl-text-', '');
  return `scales-${route.slice(1)}-${theme.value}-${scaleKey}.png`;
}
