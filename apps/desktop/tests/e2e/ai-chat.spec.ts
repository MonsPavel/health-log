/**
 * TASK-090 §19/§20: e2e полного потока «Чат» на fake-LLM (HL_FAKE_LLM=1):
 *  (1) /ai → вкладка «Чат»: модель не настроена → CTA-карточка вместо ввода (§5,
 *      как 088 AC-5.4); empty-state — подсказка и три чипа (§5);
 *  (2) вкладка «Модель»: dev-модель скачать (согласие, TEST-INSTALL §22 081) →
 *      выбрать;
 *  (3) «Чат»: чип вставляет текст в поле (не отправляет) → Enter отправляет →
 *      user-бабл сразу (оптимистичный, §12) → стрим [FAKE] в assistant-бабле
 *      (§10) → финал: пара сохранена;
 *  (4) «Какие таблетки…» → серый отказ-бабл (data-kind=refusal) с дисклеймером
 *      (AC-5.1, префильтр 086 — без движка);
 *  (5) BUSY (§20): генерация резюме идёт (запуск через реальный канал моста —
 *      «в другой вкладке»: экран разбора не смонтирован, его unmount-cancel не
 *      срабатывает) → чат-send получает ApiFailure AI/BUSY → тост «Дождитесь
 *      завершения текущей генерации» (§13). Детерминизм: fake-движок запущен с
 *      HL_FAKE_LLM_DELAY_MS (окно занятости ≈ длительность стрима), отправка —
 *      после ai:status busy;
 *  (6) перезагрузка страницы → история на месте (пара+отказ сохранены, §20);
 *  (7) «Очистить чат»: отмена — история цела; подтверждение — empty-state с
 *      чипами, лента пуста (§20).
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

/** Локальная форма моста страницы (evaluate — вне TS-DOM контекстов). */
interface ChatE2eBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(name: string, listener: (payload: { readonly state?: string }) => void): () => void;
}

const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string, fakeModelPath: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-chat-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  launch: async ({}, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (userData: string, fakeModelPath: string) => {
      // delayMs 25: окно занятости движка ≈ секунда — BUSY-сценарий не гоночен.
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

test.describe('чат с ИИ на fake-LLM (TASK-090 §20)', () => {
  test('CTA → настройка модели → чип/Enter → стрим [FAKE] → отказ-бабл → BUSY-тост → история после перезагрузки → очистка', async ({
    tmpUserData,
    launch,
  }) => {
    test.setTimeout(60_000);

    const fakeModelPath = join(tmpUserData, 'fake-source.gguf');
    await writeFile(fakeModelPath, 'fake-gguf-bytes');

    const app = await launch(tmpUserData, fakeModelPath);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // (1) /ai → «Чат»: модель не настроена → CTA вместо ввода; empty-state с чипами.
    await window.getByRole('link', { name: 'ИИ' }).click();
    await window.getByTestId('ai-tab-chat').click();
    await expect(window.getByTestId('chat-model-cta')).toBeVisible();
    await expect(window.getByTestId('chat-input')).toHaveCount(0);
    await expect(window.getByTestId('chat-empty')).toBeVisible();
    await expect(window.getByTestId('chat-chip')).toHaveCount(3);

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

    // Сидинг 8 измерений (контекст периода/порог малых данных 086 — как 088 e2e).
    await seedMeasurements(
      window,
      Array.from({ length: 8 }, (_, index) => ({
        sys: 120 + (index % 5),
        dia: 78 + (index % 4),
        takenAtUtcMs: Date.now() - (index + 1) * DAY_MS,
      })),
    );

    // (3) «Чат»: чип → поле (не отправка); Enter → оптимистичный user-бабл +
    //     виртуальный assistant-бабл со стримом [FAKE] → финал сохранён.
    await window.getByTestId('ai-tab-chat').click();
    await expect(window.getByTestId('chat-input')).toBeVisible();
    await window.getByTestId('chat-chip').first().click();
    await expect(window.getByTestId('chat-input')).toHaveValue('Как менялось давление?');
    await expect(window.getByTestId('chat-bubble')).toHaveCount(0);
    await window.getByTestId('chat-input').press('Enter');

    await expect(window.getByTestId('chat-bubble')).toHaveCount(2);
    // TASK-109 §13 (ключевой NVDA-кейс): во время стрима assistant-бабл aria-busy —
    // polite-лента (role="log") не озвучивает дельты токенов («не буква-за-буквой»).
    // Окно стрима ~1 с (25 мс/слово, шапка) — полл expect попадает в него.
    await expect(window.locator('[data-testid="chat-bubble"]').last()).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(window.getByTestId('chat-bubble').first()).toContainText('Как менялось давление?');
    await expect(window.getByTestId('chat-bubble').last()).toContainText('[FAKE]', {
      timeout: 15_000,
    });
    // Дисклеймер 089 в хвосте каждого assistant-ответа (§20 п.6 089).
    await expect(window.getByTestId('chat-bubble').last()).toContainText(
      'Это не медицинская консультация.',
    );
    // Финал: сохранённая пара без aria-busy — вставка в polite-ленту озвучивается
    // один раз, целиком (TASK-109 §13).
    await expect(window.locator('[data-testid="chat-bubble"]').last()).not.toHaveAttribute(
      'aria-busy',
    );

    // (4) Отказ (AC-5.1): «Какие таблетки…» → серый refusal-бабл с дисклеймером.
    await window.getByTestId('chat-input').fill('Какие таблетки мне принять?');
    await window.getByTestId('chat-input').press('Enter');
    const refusalBubble = window.locator('[data-testid="chat-bubble"][data-kind="refusal"]');
    await expect(refusalBubble).toBeVisible();
    await expect(refusalBubble).toContainText('Это не медицинская консультация.');
    await expect(window.getByTestId('chat-refusal-icon')).toBeVisible();

    // (5) BUSY (§20): резюме генерируется (реальный канал; экран разбора не
    //     смонтирован — unmount-cancel не срабатывает) → чат-send → тост.
    await window.evaluate(async () => {
      const bridge = (globalThis as { hl?: ChatE2eBridge }).hl;
      if (bridge === undefined) {
        throw new Error('нет моста window.hl');
      }
      const busy = new Promise<void>((resolve) => {
        const off = bridge.on('ai:status', (payload) => {
          if (payload.state === 'busy') {
            off();
            resolve();
          }
        });
      });
      const raw: unknown = await bridge.invoke('ai/summary/generate', {
        profileId: 'seed-profile-0001',
        period: '30d',
        includeNotes: false,
      });
      if ((raw as { ok?: unknown } | null)?.ok !== true) {
        throw new Error(`ai/summary/generate отклонён: ${JSON.stringify(raw)}`);
      }
      await busy; // движок занят (слот взят на первом next() генератора)
    });
    await window.getByTestId('chat-input').fill('А что сейчас с пульсом?');
    await window.getByTestId('chat-send').click();
    await expect(window.getByTestId('toast-region')).toContainText(
      'Дождитесь завершения текущей генерации',
    );

    // (6) Перезагрузка: история на месте — пара и отказ сохранены (§20 AC1).
    await window.reload();
    await expect(window.getByTestId('chat-feed')).toBeVisible();
    await expect(window.getByTestId('chat-bubble')).toHaveCount(4);
    // Роли в порядке хода: 2 user-бабла, 1 assistant, 1 refusal.
    await expect(window.locator('[data-testid="chat-bubble"][data-kind="user"]')).toHaveCount(2);
    await expect(window.locator('[data-testid="chat-bubble"][data-kind="assistant"]')).toHaveCount(
      1,
    );
    await expect(window.locator('[data-testid="chat-bubble"][data-kind="refusal"]')).toHaveCount(1);

    // (7) «Очистить чат»: отмена — история цела (§20).
    await window.getByTestId('chat-clear').click();
    const dialog = window.getByTestId('chat-clear-dialog');
    await expect(dialog).toContainText('История будет удалена необратимо.');
    await window.getByTestId('chat-clear-cancel').click();
    await expect(window.getByTestId('chat-bubble')).toHaveCount(4);

    // Подтверждение → лента пуста, empty-state с чипами (§20).
    await window.getByTestId('chat-clear').click();
    await window.getByTestId('chat-clear-confirm').click();
    await expect(window.getByTestId('chat-bubble')).toHaveCount(0);
    await expect(window.getByTestId('chat-empty')).toBeVisible();
    await expect(window.getByTestId('chat-chip')).toHaveCount(3);
  });
});
