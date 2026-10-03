/**
 * TASK-088 §19/§20: e2e полного happy-потока «Разбор» на fake-LLM (HL_FAKE_LLM=1):
 *  (1) /ai: дефолтная вкладка «Разбор»; модель не настроена → CTA-карточка вместо
 *      кнопки генерации (AC-5.4);
 *  (2) вкладка «Модель»: dev-модель скачать (согласие, TEST-INSTALL §22 081) →
 *      выбрать (AC-5.4-настройка);
 *  (3) вкладка «Разбор»: превью «Что передаётся ИИ» — точный текст проекции;
 *      сидинг 8 измерений через мост (порог kernel 7 измерений / 3 дня — иначе
 *      честный отказ малых данных 086, не путь движка); превью перечитывается
 *      (measurement:changed → «Измерений: 8»);
 *  (4) «Объяснить период» → стрим-текст с [FAKE] (префикс fake-движка 078 —
 *      детерминированный ответ, НЕ отказ префильтра) → несъёмный футер:
 *      дисклеймер + «Период анализа» (AC-5.2);
 *  (5) повторная генерация того же периода → финал из кэша — бейдж «из кэша»
 *      (FR-5.7, движок не вызывается).
 *
 * Сеть не используется: согласие перехватывает UI, генерация — fake-движок.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { closeApp, launchApp } from './helpers/launch.js';
import { seedMeasurements } from './helpers/seed-measurements.js';

/** Сутки сидинга (зеркало lib/period DAY_MS; записи — внутри дефолтного 30d). */
const DAY_MS = 86_400_000;

const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string, fakeModelPath: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-summary-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  launch: async ({}, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (userData: string, fakeModelPath: string) => {
      // TASK-109: delayMs 25 — окно стрима ≈1 с, иначе стрим завершается между
      // кадрами и aria-live off/aria-busy (§13) неуловимы (прецедент ai-chat).
      const app = await launchApp({
        userData,
        fakeLlm: true,
        fakeLlmDelayMs: 25,
        testModelFile: fakeModelPath,
      });
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      await closeApp(app).catch(() => undefined);
    }
  },
});

test.describe('разбор периода на fake-LLM (TASK-088 §20)', () => {
  test('настройка модели → превью → генерация [FAKE] с дисклеймером → повтор из кэша', async ({
    tmpUserData,
    launch,
  }) => {
    const fakeModelPath = join(tmpUserData, 'fake-source.gguf');
    await writeFile(fakeModelPath, 'fake-gguf-bytes');

    const app = await launch(tmpUserData, fakeModelPath);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // (1) /ai: вкладки на месте; дефолт — «Разбор»; модель не настроена → CTA.
    await window.getByRole('link', { name: 'ИИ' }).click();
    await expect(window.getByTestId('ai-tab-insight')).toBeVisible();
    const cta = window.getByTestId('insight-model-cta');
    await expect(cta).toBeVisible();
    await expect(window.getByTestId('insight-generate')).toHaveCount(0);

    // (2) «Модель»: скачать (согласие ДО сети, §14) → выбрать.
    // TASK-109 (сопутств. фикс среды прогона): каталог non-packaged содержит и
    // реальную Llama, и Dev Placeholder — strict mode двух model-download падал
    // на main; сужаем до карточки Dev (намерение спека — TEST-INSTALL dev-модели).
    const devCard = window
      .locator('[data-testid="model-card"]')
      .filter({ hasText: 'Dev Placeholder Model' });
    await window.getByTestId('ai-tab-model').click();
    await devCard.getByTestId('model-download').click();
    await window.getByTestId('consent-dialog').waitFor();
    await window.getByTestId('consent-confirm').click();
    await devCard.getByTestId('model-select').click();
    await expect(window.getByTestId('model-selected-badge')).toHaveText('Выбрана');

    // (3) «Разбор»: превью точного текста (пустой период — валидная проекция).
    await window.getByTestId('ai-tab-insight').click();
    const preview = window.getByTestId('ai-context-preview');
    await expect(preview).toBeVisible();

    // Сидинг через мост (arrange, §5 043): 8 измерений за 8 дней — порог kernel
    // 7/3 пройден, префильтр малых данных не сработает; measurement:changed
    // перечитывает превью — виден точный текст с новыми данными.
    await seedMeasurements(
      window,
      Array.from({ length: 8 }, (_, index) => ({
        sys: 120 + (index % 5),
        dia: 78 + (index % 4),
        takenAtUtcMs: Date.now() - (index + 1) * DAY_MS,
      })),
    );
    await expect(preview).toContainText('Измерений: 8');

    // (4) Генерация: стрим с [FAKE] (детерминированный движок) → несъёмный футер.
    await window.getByTestId('insight-generate').click();
    // TASK-109 §13 (ключевой NVDA-кейс): во время стрима регион НЕ озвучивает
    // дельты (aria-live off + aria-busy); на финале — polite, текст-узел
    // перемонтирован (вставка в polite-регион = одно озвучивание целиком).
    await expect(window.getByTestId('insight-summary-text')).toHaveAttribute('aria-live', 'off', {
      timeout: 15_000,
    });
    await expect(window.getByTestId('insight-summary-text')).toHaveAttribute('aria-busy', 'true');
    await expect(window.getByTestId('insight-summary-text')).toContainText('[FAKE]', {
      timeout: 15_000,
    });
    await expect(window.getByTestId('insight-summary-text')).toHaveAttribute('aria-live', 'polite');
    await expect(window.getByTestId('insight-summary-text')).not.toHaveAttribute('aria-busy');
    const disclaimer = window.getByTestId('insight-disclaimer');
    await expect(disclaimer).toContainText('Это не медицинская консультация.');
    await expect(disclaimer).toContainText('Период анализа:');

    // (5) Повтор того же периода — кэш FR-5.7: бейдж «из кэша», текст на месте.
    await window.getByTestId('insight-generate').click();
    await expect(window.getByTestId('insight-cached-badge')).toHaveText('из кэша', {
      timeout: 15_000,
    });
    await expect(window.getByTestId('insight-summary-text')).toContainText('[FAKE]');
    // Дисклеймер остался несъёмным и после cache-hit (AC-5.2).
    await expect(window.getByTestId('insight-disclaimer')).toContainText(
      'Это не медицинская консультация.',
    );
  });
});
