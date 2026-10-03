/**
 * TASK-108 §5/§19/§20 (AC-7.3): e2e-проверка потока ввода ТОЛЬКО с клавиатуры —
 * автоматизированный UC-01 с ФИКСИРОВАННОЙ tab-последовательностью (остальные
 * потоки — ручная ревизия по docs/a11y-keyboard.md, §19).
 *
 * Путь (клавиатура, мышиных действий нет):
 *   Tab → skip-link «Перейти к содержимому» → Enter (фокус в main) → Tab →
 *   CTA «Добавить измерение» приветствия → Enter (→ /journal, пустая история;
 *   точка последовательного обхода сохраняется — Tab продолжает с «Добавить»
 *   журнала) → Enter (форма; автофокус в СДА — MeasurementForm §5).
 *
 * Форма может открыться с восстановленным черновиком (TASK-039, persist
 * localStorage) — легальное состояние: фиксированная последовательность
 * проходится ВПЕРЁД до «Очистить» (Enter — сброс черновика) и ОБРАТНО
 * (Shift+Tab) до СДА; ввод цифр с автопереходом; снова вперёд до «Сохранить» —
 * Enter — запись «Сегодня 125/82» в истории.
 *
 * Примечание о среде: draft формы (localStorage `hl.formDraft`) в e2e-запуске
 * живёт в общем профиле %APPDATA%/Electron (изоляция HL_TEST_USER_DATA покрывает
 * БД/vault.key, §13 035) — поэтому «Очистить» в пути обязателен: прогон
 * детерминирован и с чистым хранилищем, и с черновиком прошлых прогонов.
 *
 * Единственная вариация запуска — tmp-userData (прецедент critical-path.spec.ts);
 * никаких sleep — auto-waiting (§13). Данные — синтетические 125/82/70 (§14).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';

/** Фикстуры (прецедент critical-path.spec.ts): tmp-userData + страховка закрытия. */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-kbd-'));
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
 * Клавиатурный шаг «Tab/Shift+Tab, затем ожидаемый фокус»: ассерт на toBeFocused
 * фиксирует ПОЗИЦИЮ в tab-последовательности (§5 «фиксирована»). Таб-стопы —
 * ролевые локаторы (имена из каталога, §17).
 */
async function tabTo(
  window: Page,
  target: ReturnType<Page['getByRole']>,
  reverse = false,
): Promise<void> {
  await window.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
  await expect(target).toBeFocused();
}

test.describe('UC-01 только с клавиатуры (TASK-108 §5, AC-7.3)', () => {
  test('skip-link → журнал → форма: очистка черновика, ввод 125/82/70, сохранение', async ({
    tmpUserData,
    launch,
  }) => {
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // (1) Первый Tab — skip-link (§16): на фокусе он ВИДИМ (focus:not-sr-only).
    await expect(window.getByTestId('dashboard-welcome')).toBeVisible();
    const skipLink = window.getByRole('link', { name: 'Перейти к содержимому' });
    await window.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    // Enter — переход к содержимому: фокус в main (hash не меняется — HashRouter).
    await window.keyboard.press('Enter');
    await expect(window.locator('main')).toBeFocused();

    // (2) Tab из main → первый контрол контента: CTA приветственного состояния.
    const welcomeAdd = window.getByRole('button', { name: 'Добавить измерение' });
    await tabTo(window, welcomeAdd);
    // Enter — «клик»: переход на /journal (пустая история).
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('empty-history')).toBeVisible();

    // (3) После смены маршрута точка обхода сохраняется (главный контент) —
    //     Tab продолжает с «Добавить» журнала, НЕ с начала документа.
    const addHeader = window.getByRole('button', { name: 'Добавить' }).first();
    await tabTo(window, addHeader);
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('measurement-form')).toBeVisible();

    // (4) Форма сама ставит фокус в первое поле (автофокус в sys, §5).
    await expect(window.getByTestId('input-sys')).toBeFocused();

    // (5) ФИКСИРОВАННАЯ последовательность ВПЕРЁД до «Очистить» (сброс возможного
    //     черновика TASK-039): СДА → ДДА → ЧСС → флаг → рука → заметка → когда →
    //     [Сохранить disabled на пустой форме — Tab его минует] → Отмена → Очистить.
    await tabTo(window, window.getByTestId('input-dia'));
    await tabTo(window, window.getByTestId('input-pulse'));
    await tabTo(window, window.getByRole('checkbox', { name: 'Неровный пульс' }));
    // Radio-группа — один логический стоп: фокус на checked, ←/→ переключают.
    await window.keyboard.press('Tab');
    await expect(window.locator('input[name="arm"]:checked')).toBeFocused();
    await tabTo(window, window.getByRole('textbox', { name: 'Заметка' }));
    await tabTo(window, window.getByRole('button', { name: 'Изменить' }));
    const save = window.getByRole('button', { name: 'Сохранить' });
    await expect(save).toBeDisabled(); // пустая форма — не таб-стоп (честный disabled)
    await tabTo(window, window.getByRole('button', { name: 'Отмена' }));
    const clear = window.getByRole('button', { name: 'Очистить', exact: true });
    await tabTo(window, clear);
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('input-sys')).toHaveValue('');
    await expect(window.getByTestId('input-dia')).toHaveValue('');
    await expect(window.getByTestId('input-pulse')).toHaveValue('');

    // (6) ОБРАТНЫЙ ход (Shift+Tab) до СДА; «Сохранить» всё ещё disabled —
    //     реверс идёт Отмена → Изменить.
    await tabTo(window, window.getByRole('button', { name: 'Отмена' }), true);
    await tabTo(window, window.getByRole('button', { name: 'Изменить' }), true);
    await tabTo(window, window.getByRole('textbox', { name: 'Заметка' }), true);
    await window.keyboard.press('Shift+Tab');
    await expect(window.locator('input[name="arm"]:checked')).toBeFocused();
    await tabTo(window, window.getByRole('checkbox', { name: 'Неровный пульс' }), true);
    await tabTo(window, window.getByTestId('input-pulse'), true);
    await tabTo(window, window.getByTestId('input-dia'), true);
    await tabTo(window, window.getByTestId('input-sys'), true);

    // (7) Ввод только клавишами (§16 TASK-031): цифры на readonly-полях,
    //     автопереход после 3-й цифры (§13 TASK-031).
    for (const digit of ['1', '2', '5']) {
      await window.keyboard.press(digit);
    }
    await expect(window.getByTestId('input-dia')).toBeFocused();
    for (const digit of ['8', '2']) {
      await window.keyboard.press(digit);
    }
    // ДДА не автопереходит при 2 цифрах — фиксированный Tab до ЧСС.
    await tabTo(window, window.getByTestId('input-pulse'));
    for (const digit of ['7', '0']) {
      await window.keyboard.press(digit);
    }
    await expect(window.getByTestId('input-sys')).toHaveValue('125');
    await expect(window.getByTestId('input-dia')).toHaveValue('82');
    await expect(window.getByTestId('input-pulse')).toHaveValue('70');

    // (8) Фиксированная последовательность до «Сохранить» (теперь включён —
    //     валидна форма), Enter — запись в истории (AC-7.3: сценарий без мыши).
    await tabTo(window, window.getByRole('checkbox', { name: 'Неровный пульс' }));
    await window.keyboard.press('Tab');
    await expect(window.locator('input[name="arm"]:checked')).toBeFocused();
    await tabTo(window, window.getByRole('textbox', { name: 'Заметка' }));
    await tabTo(window, window.getByRole('button', { name: 'Изменить' }));
    await tabTo(window, save);
    await window.keyboard.press('Enter');
    const row = window.getByTestId('measurement-row').filter({ hasText: '125/82' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('70 уд/мин');
  });
});
