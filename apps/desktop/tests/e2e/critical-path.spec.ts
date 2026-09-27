/**
 * TASK-035 §5: E2E критического пути UC-01 — «ввёл измерение → вижу в истории →
 * запись переживает перезапуск» (арх. 10 §1: E2E держим минимальным, но этот путь
 * свят). Реальное приложение: dev-сборка main + dist-renderer, изоляция данных —
 * tmp-userData через HL_TEST_USER_DATA (fixture ниже, §13: новая директория на
 * каждый тест — beforeEach/afterEach-семантика Playwright-фикстур).
 *
 * Шаги §5: (1) окно появилось, заголовок; (2) открыть форму, ввести 125/82/70
 * кликами (DigitPad) и клавиатурой (клавиатурность ввода — §16), Enter; (3) флаг-диалог
 * не появился (значения чистые); (4) в истории «Сегодня 125/82» (+70 уд/мин), факты
 * изоляции — health-log.db и vault.key в tmp; (5) закрыть приложение → запустить снова
 * (тот же tmp-userData) → запись на месте (персистентность зашифрованной БД + ключа, §8).
 *
 * Никаких sleep — auto-waiting Playwright (§13). Тестовые данные — фиксированные
 * синтетические 125/82/70, не пользовательские (§14).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { collectDiagnostics } from './helpers/collect-diagnostics.js';
import { closeApp, launchApp, mainProcessLogsDir } from './helpers/launch.js';

/** Имена файлов изоляции в tmp-userData (container.ts/VAULT_KEY_FILENAME). */
const DB_FILENAME = 'health-log.db';
const VAULT_FILENAME = 'vault.key';

/**
 * Фикстуры (§5 «фикстура tmp-userData»): tmpUserData — mkdtemp с очисткой после
 * теста (§14: tmp-userData очищается); launch — tracked-обёртка launchApp: страховка
 * в teardown закрывает незакрытые процессы (упавший тест не держит tmp на Windows —
 * иначе rm не пройдёт), graceful closeApp идемпотентен (§22).
 *
 * §19/§24 (ревью приёмки): при падении теста — до rm — диагностика прогона
 * (tmp-userData + общий ротационный main-лог, см. mainProcessLogsDir) копируется в
 * test-results: код ошибки repo.add/IPC виден только в логе, следующий прогон его
 * перезаписывает. Зелёный прогон ничего не копирует.
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
      await closeApp(app).catch(() => undefined);
    }
  },
});

test.describe('UC-01 критический путь (TASK-035)', () => {
  test('ввёл 125/82/70 → вижу в истории → запись переживает перезапуск', async ({
    tmpUserData,
    launch,
  }) => {
    // (1) Окно появилось, заголовок (§5; TASK-007: «Health Log» — не переводимый).
    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // (2) Открыть форму: Журнал (свежий tmp — пустое состояние) → «Добавить».
    await test.step('форма ввода: 125/82/70 кликами и клавиатурой', async () => {
      await window.getByRole('link', { name: 'Журнал' }).click();
      await window.getByTestId('empty-history').getByRole('button').click();

      // Верхнее (СДА) — кликами по DigitPad (aria-label «Ввести N», TASK-031);
      // после третьей цифры авто-переход в следующее поле (§13 TASK-031).
      for (const digit of ['1', '2', '5']) {
        await window.getByRole('button', { name: `Ввести ${digit}` }).click();
      }
      // Нижнее (ДДА) и пульс — клавиатурой (§16: попутная валидация клавиатурности).
      const diaInput = window.getByTestId('input-dia');
      await diaInput.click();
      await window.keyboard.press('8');
      await window.keyboard.press('2');
      const pulseInput = window.getByTestId('input-pulse');
      await pulseInput.click();
      await window.keyboard.press('7');
      await window.keyboard.press('0');

      await expect(window.getByTestId('input-sys')).toHaveValue('125');
      await expect(diaInput).toHaveValue('82');
      await expect(pulseInput).toHaveValue('70');

      // Enter = сохранить (§16 TASK-031).
      await pulseInput.press('Enter');
    });

    // (3) Подтверждение отсутствия флаг-диалога — значения чистые (125/82 не
    // критичны, дублей в свежей БД нет; TASK-032).
    await expect(window.getByTestId('confirm-flags-dialog')).toHaveCount(0);

    // (4) В истории появилась запись «Сегодня 125/82» + пульс.
    await test.step('запись видна в истории — «Сегодня 125/82»', async () => {
      const row = window.getByTestId('measurement-row').filter({ hasText: '125/82' });
      await expect(row).toBeVisible();
      await expect(row).toContainText('70 уд/мин');
      const todayGroup = window.getByTestId('day-group').filter({ hasText: 'Сегодня' });
      await expect(todayGroup).toContainText('125/82');

      // Факты изоляции (§20 п. 3): зашифрованная БД и ключ — в tmp-userData,
      // а не в реальном %APPDATA%/health-log.
      await expect
        .poll(() => existsSync(join(tmpUserData, DB_FILENAME)), { message: 'БД в tmp' })
        .toBe(true);
      await expect
        .poll(() => existsSync(join(tmpUserData, VAULT_FILENAME)), { message: 'vault.key в tmp' })
        .toBe(true);
    });

    // (5) Перезапуск: graceful quit (WAL-чекпоинт, §8 TASK-027) → тот же
    // tmp-userData → запись на месте (персистентность + шифрование, §8).
    await test.step('перезапуск — запись на месте', async () => {
      await closeApp(app);
      const app2 = await launch(tmpUserData);
      const window2 = await app2.firstWindow();
      await expect(window2).toHaveTitle('Health Log');
      await window2.getByRole('link', { name: 'Журнал' }).click();
      const row2 = window2.getByTestId('measurement-row').filter({ hasText: '125/82' });
      await expect(row2).toBeVisible();
      await expect(row2).toContainText('70 уд/мин');
    });
  });
});
