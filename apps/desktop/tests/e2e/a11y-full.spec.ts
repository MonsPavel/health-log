/**
 * TASK-108 §5/§19/§20: полный axe-аудит — ВСЕ 7 маршрутов × матрица
 * (2 темы × 3 масштаба) = 42 axe-прогона (§15: ≤5 мин — 6 запусков приложения
 * по одному на комбинацию, внутри комбинации маршруты обходятся навигацией).
 *
 * Критерий прохождения (§13): violations с impact critical/serious — 0 на всех
 * 42 комбинациях; moderate/minor — допустимы ТОЛЬКО если их rule-id внесён в
 * реестр отложенных DEFERRED_RULE_IDS (зеркало docs/a11y-deferred.md, §20 AC2:
 * каждая строка реестра — обоснование «почему отложено» и триггер возврата).
 * Новый moderate/minor не из реестра роняет прогон — реестр не может протухнуть
 * молча.
 *
 * СОСТАВ 7 МАРШРУТОВ (§5 «все 7 маршрутов»; РЕШЕНИЕ: 5 разделов навигации +
 * 2 состояния вне навигации — форма ввода и оверлей блокировки):
 *   1. /dashboard — динамика (с данными: карточки + график);
 *   2. /journal — история и фильтры (с данными: строки, меню, легенда);
 *   3. /journal (форма) — ввод измерения (MeasurementForm);
 *   4. /ai — вкладка «Разбор» (баннер онбординга + вкладки);
 *   5. /reports — отчёты и копии (экспорт, PDF, секция «Данные»);
 *   6. /settings — настройки (все секции простого режима);
 *   7. оверлей блокировки (LockOverlay; §16: skip-link и потоки — клавиатурная
 *      ревизия в docs/a11y-keyboard.md).
 *
 * Механика (прецедент visual-scales.spec.ts TASK-048): пустой tmp-userData +
 * сидинг 3 записей за 3 дня (arrange через реальный мост — seedMeasurements);
 * тема/масштаб применяются как пользователь — кликами в «Настройках», признаки
 * data-theme / hl-text-* на <html> — маркер применения.
 *
 * Внедрение axe (probe TASK-108): CSP окна prod-подобного запуска —
 * `script-src 'self'` (csp.ts §6) — DOM-инъекцию addScriptTag и eval страницы
 * блокирует; page.evaluate идёт через CDP и CSP не подчиняется, поэтому
 * исходник axe.min.js передаётся строкой и инстанцируется new Function
 * (единица инъекции, проверено probe-прогоном: axe.run выполняется).
 *
 * Блокировка (§5 маршрут 7): режим passphrase — arrange через реальный канал
 * vault/set-passphrase (прецедент seedMeasurements: arrange-фаза), сам оверлей —
 * vault/lock; разблокировка после аудита — UI оверлея (заодно живой прогон
 * поля/кнопки). Аудит всегда последним шагом комбинации.
 *
 * Не включено (§5): NVDA и скринридер-автоматизация — TASK-109; контраст-аудит
 * пар токенов — TASK-109 (здесь — только axe color-contrast на живом UI).
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';
import { seedMeasurements } from './helpers/seed-measurements.js';

/** Корень пакета @hl/desktop (tests/e2e/* → два уровня вверх). */
const APP_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));

/** Дистрибутив axe-core (devDependency @hl/desktop; добавлен TASK-035+). */
const AXE_SOURCE_PATH = join(APP_ROOT, 'node_modules', 'axe-core', 'axe.min.js');

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

/**
 * Сидинг: 3 записи за сегодня/вчера/3 дня назад (§19: детерминированные
 * синтетические значения). Достаточно для карточек сводки, графика daily,
 * групп «Сегодня/Вчера» и строк меню журнала — без раздувания матрицы.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_ENTRIES = (nowMs: number) =>
  [
    { sys: 124, dia: 82, takenAtUtcMs: nowMs },
    { sys: 118, dia: 76, takenAtUtcMs: nowMs - DAY_MS },
    { sys: 132, dia: 85, takenAtUtcMs: nowMs - 3 * DAY_MS },
  ] as const;

/** Тестовый пароль (arrange блокировки; политика UI min 8 — соблюдена). */
const TEST_PASSPHRASE = 'e2e-a11y-108-passphrase';

/**
 * Реестр отложенных нарушений (§13/§20 AC2): rule-id axe, допустимые в прогоне
 * с impact moderate/minor. Каждая запись ЗЕРКАЛИРОВАНА в docs/a11y-deferred.md
 * с обоснованием «почему отложено» и триггером возврата — при изменении списка
 * править оба места. Нарушение вне этого списка роняет прогон (AC2).
 */
const DEFERRED_RULE_IDS: readonly string[] = [];

/** Формат violations для сообщения упавшего ассерта (§19: падение = расследование). */
function formatViolations(
  violations: readonly {
    readonly id: string;
    readonly impact: string | null;
    readonly help: string;
    readonly nodes: readonly string[];
  }[],
): string {
  return violations
    .map(
      (violation) =>
        `${violation.impact ?? 'null'}/${violation.id}: ${violation.help} — селекторы: ${violation.nodes.join(' | ')}`,
    )
    .join('\n');
}

/** Фикстуры (прецедент visual-scales.spec.ts): tmp-userData + страховка закрытия. */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-a11y-'));
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

/** Локальная форма axe-моста на странице (глобалы страницы — не TS-DOM контекст). */
type AxeImpact = 'minor' | 'moderate' | 'serious' | 'critical' | null;
interface AxeViolation {
  readonly id: string;
  readonly impact: AxeImpact;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly unknown[] }[];
}
interface AxeBridge {
  run(
    context: Document,
    options?: Record<string, unknown>,
  ): Promise<{ readonly violations: readonly AxeViolation[] }>;
}

/** Вызов канала через реальный мост страницы (прецедент seedMeasurements §5). */
async function invokeHl(window: Page, channel: string, payload: unknown): Promise<unknown> {
  const raw: unknown = await window.evaluate(
    async ({ channel, payload }) => {
      const bridge = (
        globalThis as {
          hl?: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
        }
      ).hl;
      if (bridge === undefined) {
        throw new Error('invokeHl: preload-мост window.hl недоступен на странице');
      }
      return bridge.invoke(channel, payload);
    },
    { channel, payload },
  );
  if ((raw as { ok?: unknown } | null)?.ok !== true) {
    throw new Error(`invokeHl: ${channel} отклонён (${JSON.stringify(raw)})`);
  }
  return (raw as { data?: unknown }).data;
}

/**
 * Внедрение axe на страницу (см. шапку: CSP-совместимый путь — evaluate+Function).
 * Идемпотентно: повторный вызов в том же окне пропускается.
 */
async function injectAxe(window: Page): Promise<void> {
  const present = await window.evaluate(() => (globalThis as { axe?: unknown }).axe !== undefined);
  if (present) {
    return;
  }
  const source = await readFile(AXE_SOURCE_PATH, 'utf8');
  await window.evaluate((axeSource) => {
    const instantiate = new Function(`${axeSource}\n;return axe;`) as () => AxeBridge;
    (globalThis as { axe?: AxeBridge }).axe = instantiate();
  }, source);
  await window.waitForFunction(() => (globalThis as { axe?: unknown }).axe !== undefined);
}

/** Прогон axe по всему документу; наружу — компактный список violations. */
async function runAxe(window: Page): Promise<
  readonly { readonly id: string; readonly impact: AxeImpact; readonly help: string; readonly nodes: readonly string[] }[]
> {
  return window.evaluate(async () => {
    const axe = (globalThis as { axe?: AxeBridge }).axe;
    if (axe === undefined) {
      throw new Error('runAxe: axe не внедрён — injectAxe не вызван?');
    }
    const results = await axe.run(document);
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 6).map((node) => node.target.join(' ')),
    }));
  });
}

/**
 * Применение темы и масштаба как пользователь (прецедент visual-scales §20 AC-1):
 * клики по сегментам «Настроек»; ждём признаки data-theme / hl-text-* на <html>.
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

/** Разблокировка UI оверлея (leave маршрута 7: живой прогон поля и кнопки). */
async function unlockViaOverlay(window: Page): Promise<void> {
  await window.getByTestId('lock-pass').fill(TEST_PASSPHRASE);
  await window.getByTestId('lock-unlock').click();
  await expect(window.getByTestId('lock-overlay')).toBeHidden();
}

/** Маршрут аудита: открытие (навигация/состояние + маркер готовности) и выход. */
interface AuditRoute {
  readonly id: string;
  readonly title: string;
  readonly open: (window: Page) => Promise<void>;
  readonly leave?: (window: Page) => Promise<void>;
}

/** 7 маршрутов матрицы (состав — в шапке файла; порядок: блокировка последним). */
const ROUTES: readonly AuditRoute[] = [
  {
    id: 'dashboard',
    title: 'Динамика (/dashboard)',
    open: async (window) => {
      await window.getByRole('link', { name: 'Динамика' }).click();
      await expect(window.getByTestId('dashboard-view')).toBeVisible();
    },
  },
  {
    id: 'journal',
    title: 'Журнал — история и фильтры (/journal)',
    open: async (window) => {
      await window.getByRole('link', { name: 'Журнал' }).click();
      await expect(window.getByTestId('measurement-row').first()).toBeVisible();
    },
  },
  {
    id: 'journal-form',
    title: 'Журнал — форма ввода',
    open: async (window) => {
      await window.getByRole('button', { name: 'Добавить' }).click();
      await expect(window.getByTestId('measurement-form')).toBeVisible();
    },
  },
  {
    id: 'ai',
    title: 'ИИ — вкладка «Разбор» (/ai)',
    open: async (window) => {
      await window.getByRole('link', { name: 'ИИ' }).click();
      await expect(window.getByTestId('insight-screen')).toBeVisible();
    },
  },
  {
    id: 'reports',
    title: 'Отчёты и копии (/reports)',
    open: async (window) => {
      await window.getByRole('link', { name: 'Отчёты' }).click();
      await expect(window.getByRole('heading', { name: 'Отчёты' })).toBeVisible();
    },
  },
  {
    id: 'settings',
    title: 'Настройки (/settings)',
    open: async (window) => {
      await window.getByRole('link', { name: 'Настройки' }).click();
      await expect(window.getByRole('group', { name: 'Тема' })).toBeVisible();
    },
  },
  {
    id: 'lock',
    title: 'Блокировка (оверлей)',
    open: async (window) => {
      await invokeHl(window, 'vault/lock', {});
      await expect(window.getByTestId('lock-overlay')).toBeVisible();
    },
    leave: unlockViaOverlay,
  },
];

test.describe('a11y-матрица 7 маршрутов × 2 темы × 3 масштаба (TASK-108 §5/§20)', () => {
  // 6 комбинаций × 7 маршрутов × (навигация+axe) в одном тесте — 30 с конфига мало.
  test.setTimeout(120_000);

  for (const theme of THEMES) {
    for (const scale of SCALES) {
      test(`${theme.label} тема × ${scale.label}: 0 critical/serious на 7 маршрутах`, async ({
        tmpUserData,
        launch,
      }) => {
        const app = await launch(tmpUserData);
        const window = await app.firstWindow();
        await expect(window).toHaveTitle('Health Log');

        // Arrange: данные (карточки/график/строки) + axe + режим пароля (§5 маршрут 7).
        await seedMeasurements(window, SEED_ENTRIES(Date.now()));
        await injectAxe(window);
        await invokeHl(window, 'vault/set-passphrase', { action: 'set', pass: TEST_PASSPHRASE });
        await applyAppearanceViaSettings(window, theme, scale);

        // Обход 7 маршрутов: нарушения КОПЯТСЯ по всем маршрутам (упавший ассерт
        // в конце показывает полную карту комбинации — падение = расследование
        // §19 без многораундовых прогонов); leave() выполняется всегда —
        // следующий маршрут не стартует из заблокированного состояния.
        const problems: string[] = [];
        for (const route of ROUTES) {
          await test.step(route.title, async () => {
            await route.open(window);
            const violations = await runAxe(window);

            // §13: critical/serious — блокер, чинится в задаче (AC1: 0 на 42 прогонах).
            const blockers = violations.filter(
              (violation) => violation.impact === 'critical' || violation.impact === 'serious',
            );
            if (blockers.length > 0) {
              problems.push(
                `«${route.title}» — critical/serious:\n${formatViolations(blockers)}`,
              );
            }

            // §13/AC2: moderate/minor — только из реестра docs/a11y-deferred.md.
            const offRegistry = violations.filter(
              (violation) =>
                violation.impact !== 'critical' &&
                violation.impact !== 'serious' &&
                !DEFERRED_RULE_IDS.includes(violation.id),
            );
            if (offRegistry.length > 0) {
              problems.push(
                `«${route.title}» — moderate/minor вне реестра docs/a11y-deferred.md:\n${formatViolations(offRegistry)}`,
              );
            }

            await route.leave?.(window);
          });
        }
        expect(
          problems.join('\n\n'),
          `нарушения axe (${theme.value} × ${scale.cls}); реестр отложенных — docs/a11y-deferred.md`,
        ).toBe('');
      });
    }
  }
});
