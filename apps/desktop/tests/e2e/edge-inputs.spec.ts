/**
 * TASK-043 §2/§5: E2E пограничных вводов и подтверждений (эпик 2.2 — барьеры
 * качества данных). Барьеры регрессируют тихо при любом рефакторинге формы/диалогов
 * (§3), поэтому AC-1.2/1.3/1.4 SRS защищены сквозными сценариями поверх ПОЛНОГО
 * стека: dev-сборка main + dist-renderer, tmp-userData, моков main нет (§19).
 *
 * Шесть сценариев §5:
 *  (1) EC-01: 125/130 (СДА ≤ ДДА) → ошибка формы, «Сохранить» недоступна, ввод не
 *      потерян (оба assert'а §13), запись не сохраняется;
 *  (2) EC-03: 185/115 → диалог «Проверьте значения» с панелью срочности (TASK-041);
 *      ветка «Удалить и исправить» → форма со значениями; повторное сохранение →
 *      Esc = безопасное «Оставить» (§16: фокус в диалоге, safe-семантика);
 *  (3) 190/125 → панель FR-7.4 с номером «103» (полный текст TASK-041);
 *  (4) EC-04 дубль: та же пара дважды в окне 2 мин → диалог дубля → «Оставить» →
 *      в списке ДВЕ записи (§20);
 *  (5) AC-1.4 typo: история 14 дней 128/82 (сидинг через window.hl.invoke —
 *      arrange, §5) → ввод 169/82 → подсказка с медианой «128» → «Оставить»;
 *  (6) CRUD-цикл TASK-038: создать → изменить 125→127 → удалить → подтверждение →
 *      список пуст.
 *
 * Ассерты по RU-текстам каталога (§17: e2e на дефолтной локали ru) — по стабильным
 * подстрокам, числа-подстановки включительно (§22 риск). Селекторы — data-testid,
 * у элементов без testid — стабильные id/role+name (критический путь TASK-035).
 * Изоляция — tmp-userData fixture TASK-035: новая директория на каждый тест
 * (§20 повторный прогон), при падении — диагностика в test-results (§19).
 *
 * НАХОДКИ e2e (§3 — «барьеры регрессируют тихо»), зафиксированные при написании:
 *  1. Черновик формы (zustand-persist `hl.formDraft`, TASK-039) живёт в
 *     localStorage дефолтного userData, который HL_TEST_USER_DATA НЕ изолирует
 *     (bootstrap подменяет путь только контейнеру БД) — см. launchedWindow.
 *  2. Правка записи была сломана сквозным образом: assembleUpdateRequest
 *     протаскивал profileId в strict-схему `measurements/update` → каркас IPC
 *     молча отдавал VALIDATION/FAILED до хендлера; исправлено в
 *     use-update-measurement.ts (выборочный перенос полей add) — минимальная
 *     неизбежная правка продукта, без неё сценарий (6) непроходим.
 *  3. Гонка источников времени «renderer submit vs main domain» при «сейчас»
 *     (допуск 0 мс, bp-measurement.ts §13): Chromium-часы страницы читаются
 *     до ~16 мс впереди часов main (квант coarse-часов) — спурьезный
 *     MEASUREMENT/FUTURE_TIME. Домен (TASK-017) сознательно не трогается:
 *     сценарии сохраняют через продуктовый путь WhenField «Изменить» (префилл
 *     текущей настенной минуты — takenAt ≤ now по построению, см.
 *     setWhenToCurrentWallMinute). Толерантность в домене — решение владельца
 *     TASK-017/SRS EC-20, не этой задачи.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';

import { collectDiagnostics } from './helpers/collect-diagnostics.js';
import { fillForm } from './helpers/fill-form.js';
import { closeApp, launchApp, mainProcessLogsDir } from './helpers/launch.js';
import { seedMeasurements } from './helpers/seed-measurements.js';

/** Сутки в мс — сидинг истории typo-сценария (k·24ч назад, окно эвристики 14 дней). */
const MS_PER_DAY = 86_400_000;

/**
 * Защитный сдвиг сидинга «сейчас» (находка 3 в шапке): метка времени берётся
 * Date.now() процесса-раннера ДО пути «страница → IPC → main» — при ступенчатой
 * подстройке системных часов хоста main может прочитать время позади захвата,
 * и add с допуском 0 мс (bp-measurement.ts §13) отклонит FUTURE_TIME. Сдвиг 5 с
 * на эвристики сценариев не влияет (окна 2 мин / 14 дней, медианы неизменны).
 */
const SEED_CLOCK_GUARD_MS = 5_000;

/**
 * Фикстуры — зеркало критического пути (TASK-035): tmpUserData — mkdtemp с очисткой
 * после теста (диагностика падения — ДО rm, §19); launch — tracked-обёртка launchApp
 * со страховкой closeApp в teardown (graceful quit идемпотентен, §22 TASK-035).
 */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-'));
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
      // Находка 1 в шапке: черновик формы (localStorage) общий для всех e2e-запусков —
      // чистим ДО graceful quit, чтобы набор не оставлял hl.formDraft следующим
      // прогонам (критический путь TASK-035 запускается тем же command §24 и без
      // этого ловит восстановленный черновик в полях формы).
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
 * Окно приложения с чистым состоянием страницы (заголовок не переводится, TASK-007).
 *
 * Изоляция ЧЕРНОВИКА формы (эмпирика TASK-043, §20 «повторный прогон»):
 * HL_TEST_USER_DATA подменяет путь только контейнеру (БД/vault — bootstrap.ts:
 * resolveUserDataPath), а localStorage Electron (zustand-persist `hl.formDraft`,
 * TASK-039) живёт в дефолтном userData («Electron») и переживает прогоны —
 * восстановленный черновик («Черновик восстановлен») забивает поля до старта
 * сценария (appendDigit ограничен 3 цифрами — ввод эвристик игнорируется).
 * localStorage чистится ДО перезагрузки страницы: store создаётся заново на
 * пустом хранилище, каждый тест стартует с пустой формой детерминированно.
 */
async function launchedWindow(
  launch: (userData: string) => Promise<ElectronApplication>,
  userData: string,
): Promise<Page> {
  const app = await launch(userData);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle('Health Log');
  await window.evaluate(() => {
    (globalThis as { localStorage?: { clear: () => void } }).localStorage?.clear();
  });
  await window.reload();
  await expect(window).toHaveTitle('Health Log');
  return window;
}

/** Открыть форму через CTA пустого состояния (свежая БД — случай 5 сценариев). */
async function openFormFromEmpty(window: Page): Promise<void> {
  await window.getByRole('link', { name: 'Журнал' }).click();
  await window.getByTestId('empty-history').getByRole('button').click();
}

/** Открыть форму кнопкой «Добавить» шапки списка (история уже не пуста — §5 TASK-033). */
async function openFormFromList(window: Page): Promise<void> {
  await window.getByRole('link', { name: 'Журнал' }).click();
  await window.getByRole('button', { name: 'Добавить' }).click();
}

/** «Отмена» — возврат к списку (форма — вид вкладки журнала, §5 TASK-031). */
async function backToList(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Отмена' }).click();
}

/**
 * Перевод поля «когда» в ручной режим кнопкой «Изменить» (WhenField, TASK-031):
 * префилл — текущие настенные дата/время с точностью до минуты, взятые на момент
 * открытия формы. takenAt на submit собирается заново из настенных компонентов —
 * заведомо ≤ now (0…60 с назад) — сохранение не зависит от гонки источников
 * времени «страница vs main» (см. находку 3 в шапке). Кнопка одна в форме
 * (пункт меню строки «Изменить» — вне вида формы).
 */
async function setWhenToCurrentWallMinute(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Изменить' }).click();
}

/** Открыть меню действий строки (⋮, TASK-038) по подстроке значений записи. */
async function openRowMenu(window: Page, rowText: string): Promise<void> {
  await window
    .getByTestId('measurement-row')
    .filter({ hasText: rowText })
    .getByRole('button', { name: 'Действия с записью' })
    .click();
}

test.describe('Пограничные вводы и подтверждения (TASK-043)', () => {
  test('(1) EC-01: 125/130 — ошибка формы, сохранение недоступно, ввод не потерян', async ({
    tmpUserData,
    launch,
  }) => {
    const window = await launchedWindow(launch, tmpUserData);

    await test.step('форма: 125 в СДА, 130 в ДДА (СДА ≤ ДДА)', async () => {
      await openFormFromEmpty(window);
      await fillForm(window, { sys: '125', dia: '130' });
    });

    // §13 (оба assert'а): «сохранение недоступно» И «введённое не потеряно».
    await test.step('мягкая ошибка dia + кнопка сохранения заблокирована + значения на месте', async () => {
      // Нарушитель инварианта — dia (refine sysLeDia → поле dia, TASK-031 §13);
      // текст ошибки — ключ errors.sysLeDia каталога (§17).
      const diaError = window.locator('#dia-error');
      await expect(diaError).toBeVisible();
      await expect(diaError).toHaveText(
        'Систолическое давление должно быть больше диастолического.',
      );
      await expect(window.getByTestId('input-dia')).toHaveAttribute('aria-invalid', 'true');
      await expect(window.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
      await expect(window.getByTestId('input-sys')).toHaveValue('125');
      await expect(window.getByTestId('input-dia')).toHaveValue('130');
    });

    await test.step('запись не сохраняется: отмена → список пуст (EC-01)', async () => {
      await backToList(window);
      await expect(window.getByTestId('empty-history')).toBeVisible();
      await expect(window.getByTestId('measurement-row')).toHaveCount(0);
    });
  });

  test('(2) EC-03: 185/115 — диалог с панелью срочности; «Исправить» → форма со значениями; Esc = safe', async ({
    tmpUserData,
    launch,
  }) => {
    const window = await launchedWindow(launch, tmpUserData);

    await test.step('форма: 185/115 → Сохранить', async () => {
      await openFormFromEmpty(window);
      await setWhenToCurrentWallMinute(window);
      await fillForm(window, { sys: '185', dia: '115' });
      await window.getByRole('button', { name: 'Сохранить' }).click();
    });

    await test.step('диалог «Проверьте значения» с панелью срочности (185/115, TASK-041)', async () => {
      const dialog = window.getByTestId('confirm-flags-dialog');
      await expect(dialog).toBeVisible();
      const panel = window.getByTestId('critical-panel');
      await expect(panel).toBeVisible();
      // Значения записи подставлены в интро панели (params {pressure}).
      await expect(panel).toContainText('185/115');
      // §16: фокус в диалоге — Radix ловит фокус в контенте (первый фокусируемый
      // элемент — dismiss панели), проверяем activeElement внутри диалога.
      const focusInsideDialog = await window.evaluate(() => {
        const doc = (
          globalThis as {
            document?: {
              activeElement?: unknown;
              querySelector?: (
                selector: string,
              ) => { contains: (other: unknown) => boolean } | null;
            };
          }
        ).document;
        if (doc?.querySelector === undefined || doc.activeElement === null) {
          return false;
        }
        const dialog = doc.querySelector('[data-testid="confirm-flags-dialog"]');
        return dialog !== null && dialog !== undefined && dialog.contains(doc.activeElement);
      });
      expect(focusInsideDialog).toBe(true);
    });

    await test.step('ветка «Удалить и исправить» → форма со значениями (§13: обе ветки диалога)', async () => {
      await window.getByTestId('dialog-delete-fix').click();
      await expect(window.getByTestId('confirm-flags-dialog')).toHaveCount(0);
      // Значения возвращены в форму (store не очищался — TASK-032 §10).
      await expect(window.getByTestId('input-sys')).toHaveValue('185');
      await expect(window.getByTestId('input-dia')).toHaveValue('115');
    });

    await test.step('повторное сохранение → Esc = безопасное «Оставить» (§16)', async () => {
      await window.getByRole('button', { name: 'Сохранить' }).click();
      await expect(window.getByTestId('confirm-flags-dialog')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('confirm-flags-dialog')).toHaveCount(0);
      await expect(window.getByTestId('saved-toast')).toBeVisible();
    });

    await test.step('запись сохранена: в списке с критическим бейджем (TASK-042)', async () => {
      await backToList(window);
      const row = window.getByTestId('measurement-row').filter({ hasText: '185/115' });
      await expect(row).toBeVisible();
      await expect(row.getByTestId('flag-critical')).toBeVisible();
    });
  });

  test('(3) 190/125 — панель FR-7.4 с номером «103» (TASK-041)', async ({
    tmpUserData,
    launch,
  }) => {
    const window = await launchedWindow(launch, tmpUserData);

    await test.step('форма: 190/125 → Сохранить', async () => {
      await openFormFromEmpty(window);
      await setWhenToCurrentWallMinute(window);
      await fillForm(window, { sys: '190', dia: '125' });
      await window.getByRole('button', { name: 'Сохранить' }).click();
    });

    await test.step('панель FR-7.4: криз, значения записи, номера 103/112 по локали ru', async () => {
      const panel = window.getByTestId('critical-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('190/125');
      await expect(panel).toContainText('гипертонический криз');
      // Реестр номеров по языку интерфейса (ru → 103/112, TASK-041 §5/§17).
      await expect(panel).toContainText('103');
      await expect(panel).toContainText('112');
    });

    await test.step('Esc («Оставить») — запись сохранена, работа не заблокирована (AC-6.1)', async () => {
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('confirm-flags-dialog')).toHaveCount(0);
      await backToList(window);
      await expect(
        window.getByTestId('measurement-row').filter({ hasText: '190/125' }),
      ).toBeVisible();
    });
  });

  test('(4) EC-04: дубль в окне 2 мин — диалог, «Оставить» → в списке ДВЕ записи', async ({
    tmpUserData,
    launch,
  }) => {
    const window = await launchedWindow(launch, tmpUserData);

    await test.step('arrange: первая запись 125/82 через IPC-сидинг (§5)', async () => {
      // Метка «сейчас» с защитным сдвигом (находка 3): в окне дубля 2 мин от
      // сохранения через форму (настенная минута, ≤60 с назад) гарантированно.
      await seedMeasurements(window, [
        { sys: 125, dia: 82, takenAtUtcMs: Date.now() - SEED_CLOCK_GUARD_MS },
      ]);
    });

    await test.step('act: та же пара через форму → диалог дубля', async () => {
      await openFormFromList(window);
      // Дубль-окно 2 мин: момент сохранения (настенная минута) в пределах окна
      // от сидинга «сейчас» — |Δ| ≤ 60 с + реальная пауза (§7 TASK-019).
      await setWhenToCurrentWallMinute(window);
      await fillForm(window, { sys: '125', dia: '82' });
      await window.getByRole('button', { name: 'Сохранить' }).click();
      await expect(window.getByTestId('confirm-flags-dialog')).toBeVisible();
      await expect(window.getByTestId('hint-duplicate')).toBeVisible();
    });

    await test.step('«Оставить» — в списке ДВЕ записи 125/82 (§20)', async () => {
      await window.getByTestId('dialog-keep').click();
      await expect(window.getByTestId('confirm-flags-dialog')).toHaveCount(0);
      await backToList(window);
      await expect(window.getByTestId('measurement-row').filter({ hasText: '125/82' })).toHaveCount(
        2,
      );
      await expect(window.getByTestId('history-shown')).toHaveText('Показано 2 из 2');
    });
  });

  test('(5) AC-1.4: история 14 дней 128/82 → 169/82 — подсказка с медианой «128»', async ({
    tmpUserData,
    launch,
  }) => {
    const window = await launchedWindow(launch, tmpUserData);

    // Сидинг в окне TypoHeuristic (14 дней ДО момента кандидата, §5): k = 0…13
    // плюс защитный сдвиг захвата времени (находка 3) — даже если самая свежая
    // запись выйдет за минутный срез кандидата, медиана 13…14 значений 128
    // неизменна.
    await test.step('arrange: 14 дней 128/82 через IPC-сидинг (§5)', async () => {
      const now = Date.now() - SEED_CLOCK_GUARD_MS;
      await seedMeasurements(
        window,
        Array.from({ length: 14 }, (_, k) => ({
          sys: 128,
          dia: 82,
          takenAtUtcMs: now - k * MS_PER_DAY,
        })),
      );
    });

    await test.step('act: 169/82 → подсказка typo с медианой «128» (§13: params сквозным i18n)', async () => {
      await openFormFromList(window);
      // Окно typo — 14 дней ДО момента кандидата: настенная минута сохранения
      // держит все 14 сидингов (0…13 дней назад) в окне (§9 add-measurement).
      await setWhenToCurrentWallMinute(window);
      await fillForm(window, { sys: '169', dia: '82' });
      await window.getByRole('button', { name: 'Сохранить' }).click();
      await expect(window.getByTestId('confirm-flags-dialog')).toBeVisible();
      // |169 − 128| = 41 > порога 40 (TYPO_THRESHOLD_MMHG) — сигнал именно по СДА.
      await expect(window.getByTestId('hint-typo')).toContainText('128');
      await expect(window.getByTestId('hint-typo')).toContainText('169');
    });

    await test.step('«Оставить» — запись сохранена', async () => {
      await window.getByTestId('dialog-keep').click();
      await backToList(window);
      await expect(
        window.getByTestId('measurement-row').filter({ hasText: '169/82' }),
      ).toBeVisible();
    });
  });

  test('(6) CRUD-цикл (TASK-038): создать → изменить 125→127 → удалить → подтверждение → пусто', async ({
    tmpUserData,
    launch,
  }) => {
    const window = await launchedWindow(launch, tmpUserData);

    await test.step('создать 125/82/70', async () => {
      await openFormFromEmpty(window);
      await setWhenToCurrentWallMinute(window);
      await fillForm(window, { sys: '125', dia: '82', pulse: '70' });
      await window.getByRole('button', { name: 'Сохранить' }).click();
      await expect(
        window.getByTestId('measurement-row').filter({ hasText: '125/82' }),
      ).toBeVisible();
    });

    await test.step('изменить 125→127: форма edit, «Правка применена», в списке 127/82', async () => {
      await openRowMenu(window, '125/82');
      await window.getByTestId('row-menu-edit').click();
      // Режим edit (TASK-038 §5): заголовок «Изменение записи», поля из DTO.
      await expect(window.getByTestId('form-title')).toHaveText('Изменение записи');
      await expect(window.getByTestId('input-sys')).toHaveValue('125');
      await expect(window.getByTestId('input-dia')).toHaveValue('82');
      // Поля readonly — правка клавиатурой (§16): очистить СДА, ввести 127.
      await window.getByTestId('input-sys').click();
      for (let i = 0; i < 3; i += 1) {
        await window.keyboard.press('Backspace');
      }
      await window.keyboard.press('1');
      await window.keyboard.press('2');
      await window.keyboard.press('7');
      await window.getByRole('button', { name: 'Сохранить' }).click();
      await expect(window.getByTestId('history-notice')).toHaveText('Правка применена');
      await expect(
        window.getByTestId('measurement-row').filter({ hasText: '127/82' }),
      ).toBeVisible();
    });

    await test.step('удалить: подтверждение «необратимо» → список пуст (§5/§20)', async () => {
      await openRowMenu(window, '127/82');
      await window.getByTestId('row-menu-delete').click();
      await expect(window.getByTestId('delete-confirm-dialog')).toBeVisible();
      await expect(window.getByTestId('delete-confirm-body')).toContainText('необратимо');
      await window.getByTestId('delete-confirm').click();
      // Список пуст: удалена единственная запись — экран уходит в EmptyHistory
      // (early-return HistoryScreen: заметки «Удалено» в пустом состоянии нет).
      await expect(window.getByTestId('measurement-row')).toHaveCount(0);
      await expect(window.getByTestId('empty-history')).toBeVisible();
    });
  });
});
