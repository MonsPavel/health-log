/**
 * TASK-088 §19/§20: компонентные тесты экрана «Разбор» (мок-каналы, прецедент
 * ModelsScreen.test.ts):
 *  - AC-5.5: превью-тумблер заметок меняет текст превью (notes появились) и
 *    персистится в prefs.aiSettings.includeNotes;
 *  - генерация: generate invoke {profileId, period, includeNotes} → токены
 *    аппендятся живьём, финал — тост «сохранён» + refetch latest (AC-5.2/§12);
 *    cache-hit финал — бейдж «из кэша»;
 *  - «Стоп» — ai/cancel invoke; после финала кнопки нет;
 *  - отказ (финал без summaryId, стопа не было) — серый стиль с иконкой (§10);
 *  - стейлс-бейдж из latest.stale — клик = перегенерация (§10);
 *  - BUSY — тост-подсказка «генерация уже идёт» (§13);
 *  - модель не настроена → CTA-карточка вместо кнопки генерации (AC-5.4);
 *  - гонки §13: смена периода и unmount во время генерации → авто-cancel;
 *  - прерывание без финала (ai:status ready) → блок ошибки с «Повторить»;
 *  - «Очистить разборы» — подтверждение → delete-all invoke (§5);
 *  - §15: 1000 токенов fake за < 2 с UI-времени.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { HlEventMap } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { createQueryClient } from '../../../lib/query-client';
import { InsightScreen } from './InsightScreen';

/** Типизированный мок моста: канал → Promise (no-misused-promises, §19). */
type InvokeMock = ReturnType<typeof vi.fn<(channel: string, payload: unknown) => Promise<unknown>>>;

let invoke: InvokeMock;
// Мок моста хранит ВСЕ подписки на имя (реальный мост доставляет каждой) —
// на экране их несколько (превью и latest слушают measurement:changed).
let eventListeners: Partial<Record<keyof HlEventMap, Array<(payload: unknown) => void>>>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });
const FAIL = (code: string, messageKey: string) => ({
  v: 1,
  ok: false,
  error: { code, messageKey },
});

const PREFS = (over: Record<string, unknown> = {}) => ({
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false, modelsDownload: true },
  jobState: { jobs: {}, shown: {} },
  aiSettings: { dismissed: true, includeNotes: false, modelId: 'dev-placeholder-ru' },
  ...over,
});

const LIST_INSTALLED = {
  models: [
    {
      descriptor: {
        id: 'dev-placeholder-ru',
        name: 'Dev Placeholder Model',
        version: '0.0.0-dev',
        file: 'dev-placeholder.gguf',
        url: 'https://PLACEHOLDER.invalid/models/dev-placeholder.gguf',
        sha256: '0'.repeat(64),
        sizeBytes: 1,
        languages: ['ru', 'en'],
        minRamGb: 8,
        license: 'UNLICENSED-DEV-PLACEHOLDER',
      },
      state: 'installed',
    },
  ],
  ramTotalGb: 31.3,
  uiLanguage: 'ru',
};

/** Точные тексты превью: различие секции заметок — маркер тумблера (AC-5.5). */
const PREVIEW_WITHOUT_NOTES = '# Период [period]\nДиапазон: 01.03.2026–08.03.2026\nИзмерений: 8';
const PREVIEW_WITH_NOTES = `${PREVIEW_WITHOUT_NOTES}\n\n## Заметки [notes]\nЗаметка: утром таблетка`;

const SUMMARY_DTO = {
  id: 's-1',
  periodStartUtc: 1000,
  periodEndUtc: 2000,
  modelId: 'dev-placeholder-ru',
  modelVersion: '0.0.0-dev',
  dataVersion: 3,
  contentMd: 'Сохранённый разбор: среднее СДА 124.',
  disclaimerText: 'Это не является медицинской консультацией.',
  periodText: 'последние 30 дней',
  createdAtUtc: 5000,
};

function defaultInvoke(): InvokeMock {
  return vi
    .fn<(channel: string, payload: unknown) => Promise<unknown>>()
    .mockImplementation((channel: string, payload: unknown) => {
      if (channel === 'ai/models/list') {
        return Promise.resolve(OK(LIST_INSTALLED));
      }
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS()));
      }
      if (channel === 'prefs/set') {
        return Promise.resolve(
          OK(
            PREFS({
              aiSettings: { dismissed: true, includeNotes: true, modelId: 'dev-placeholder-ru' },
            }),
          ),
        );
      }
      if (channel === 'ai/context/preview') {
        const request = payload as { includeNotes?: boolean };
        return Promise.resolve(
          OK({
            text: request.includeNotes === true ? PREVIEW_WITH_NOTES : PREVIEW_WITHOUT_NOTES,
            sections:
              request.includeNotes === true ? ['period', 'daily', 'notes'] : ['period', 'daily'],
            hash: 'a'.repeat(64),
          }),
        );
      }
      if (channel === 'ai/summary/generate') {
        return Promise.resolve(OK({ requestId: 'r1' }));
      }
      if (channel === 'ai/summary/latest') {
        return Promise.resolve(OK({ summary: SUMMARY_DTO, stale: false }));
      }
      if (channel === 'ai/summary/delete-all') {
        return Promise.resolve(OK(null));
      }
      if (channel === 'ai/cancel') {
        return Promise.resolve(OK({ cancelled: true }));
      }
      return Promise.resolve(OK({}));
    });
}

function renderScreen(options: { onGoToModel?: () => void; url?: string } = {}): void {
  render(
    createElement(
      MemoryRouter,
      { initialEntries: [options.url ?? '/?tab=insight'] },
      createElement(
        ToastProvider,
        null,
        createElement(
          QueryClientProvider,
          { client: createQueryClient() },
          createElement(InsightScreen, { onGoToModel: options.onGoToModel ?? (() => undefined) }),
        ),
      ),
    ),
  );
}

/** Вызовы канала моста: [channel, payload] (типизированный мок — один аргумент). */
const payloadsOf = (channel: string): unknown[] =>
  invoke.mock.calls
    .filter((call) => call[0] === channel)
    .map((call) => (call as unknown as unknown[])[1]);

/** Токен/финал/статус активной генерации — в подписки моста (useHlEvent). */
const emit = (name: keyof HlEventMap, payload: unknown): void => {
  for (const listener of eventListeners[name] ?? []) {
    listener(payload);
  }
};

beforeEach(() => {
  invoke = defaultInvoke();
  eventListeners = {};
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: keyof HlEventMap, listener: (payload: unknown) => void) => {
        const bucket = eventListeners[name] ?? (eventListeners[name] = []);
        bucket.push(listener);
        return () => {
          eventListeners[name] = bucket.filter((entry) => entry !== listener);
        };
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
  localStorage.clear();
});

describe('InsightScreen — превью контекста и тумблер заметок (AC-5.5, §5)', () => {
  it('превью показывает точный текст; тумблер → prefs/set includeNotes и текст с заметками', async () => {
    renderScreen();

    const preview = await screen.findByTestId('ai-context-preview');
    expect(preview.textContent).toContain('# Период [period]');
    expect(preview.textContent).not.toContain('утром таблетка');

    fireEvent.click(screen.getByTestId('insight-notes-toggle'));

    await waitFor(() =>
      expect(payloadsOf('ai/context/preview')[1]).toEqual({
        profileId: 'seed-profile-0001',
        period: '30d',
        includeNotes: true,
      }),
    );
    await waitFor(() => expect(preview.textContent).toContain('утром таблетка'));
    const setPayloads = payloadsOf('prefs/set');
    expect(setPayloads[0]).toMatchObject({
      patch: { aiSettings: { includeNotes: true, modelId: 'dev-placeholder-ru' } },
    });
  });

  it('measurement:changed → превью перечитывается (§4: пользователь видит ТОЧНЫЙ текст ухода)', async () => {
    renderScreen();
    await screen.findByTestId('ai-context-preview');
    const previewCallsBefore = payloadsOf('ai/context/preview').length;

    emit('measurement:changed', { profileId: 'seed-profile-0001' });

    await waitFor(() => {
      expect(payloadsOf('ai/context/preview').length).toBeGreaterThan(previewCallsBefore);
    });
  });
});

describe('InsightScreen — генерация: стрим, финал, «Стоп» (AC §20, §12)', () => {
  it('токены аппендятся живьём; финал — тост «сохранён» + refetch latest (latest отвечает)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));

    await waitFor(() =>
      expect(payloadsOf('ai/summary/generate')[0]).toEqual({
        profileId: 'seed-profile-0001',
        period: '30d',
        includeNotes: false,
      }),
    );
    const latestCallsBefore = payloadsOf('ai/summary/latest').length;

    emit('ai:token', { requestId: 'r1', text: 'Среднее СДА ' });
    await waitFor(() =>
      expect(screen.getByTestId('insight-summary-text').textContent).toContain('Среднее СДА'),
    );
    emit('ai:token', { requestId: 'r1', text: '124 — в целевой зоне.' });
    await waitFor(() =>
      expect(screen.getByTestId('insight-summary-text').textContent).toContain(
        '124 — в целевой зоне.',
      ),
    );

    emit('ai/summary/result', { requestId: 'r1', summaryId: 's1', cached: false, stale: false });

    // §12: финал генерации инвалидирует latest — refetch (кэш ['summary-latest', …]).
    await waitFor(() => {
      expect(payloadsOf('ai/summary/latest').length).toBeGreaterThan(latestCallsBefore);
    });
    expect(screen.getByTestId('toast-region').textContent).toContain('сохранён');
    // «Стоп» после финала исчезает (§10: только во время генерации).
    expect(screen.queryByTestId('insight-stop')).toBeNull();
  });

  it('финал cache-hit — бейдж «из кэша» + текст из latest (кэш не стримится, решение 087)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    // Кэш-hit стримом текст НЕ идёт (движок не трогается): финал → latest refetch.
    emit('ai/summary/result', { requestId: 'r1', summaryId: 's1', cached: true, stale: false });

    await waitFor(() => expect(screen.getByTestId('insight-cached-badge')).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId('insight-summary-text').textContent).toContain(
        'Сохранённый разбор',
      ),
    );
    // Дисклеймер — из DTO сохранённой записи (несъёмный и в кэше, AC-5.2).
    expect(screen.getByTestId('insight-disclaimer').textContent).toContain(
      'Это не является медицинской консультацией.',
    );
  });

  it('«Стоп» во время генерации → ai/cancel invoke (FR-5.7/EC-16)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    emit('ai:token', { requestId: 'r1', text: 'Частичный ' });
    fireEvent.click(screen.getByTestId('insight-stop'));

    await waitFor(() => expect(payloadsOf('ai/cancel')[0]).toEqual({ requestId: 'r1' }));
  });

  it('отказ (финал без summaryId, стопа не было) — серый блок с info-иконкой (§10)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    emit('ai:token', { requestId: 'r1', text: 'Данных пока мало — я не буду делать выводов.' });
    emit('ai/summary/result', { requestId: 'r1', cached: false, stale: false });

    await waitFor(() =>
      expect(screen.getByTestId('insight-summary-text').getAttribute('data-kind')).toBe('refusal'),
    );
    expect(screen.getByTestId('insight-refusal-icon')).toBeDefined();
  });

  it('прерывание без финала (ai:status ready) — блок ошибки с «Повторить»; повтор заново вызывает generate', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    emit('ai:status', { state: 'ready', requestId: 'r1' });

    const error = await screen.findByTestId('insight-error');
    expect(error.textContent).toContain('прервана');
    fireEvent.click(screen.getByTestId('insight-retry'));

    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(2));
  });
});

describe('InsightScreen — стейлс-бейдж и пустое состояние (§12)', () => {
  it('latest.stale=true → жёлтый бейдж над текстом; клик = перегенерация (§10)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/summary/latest') {
        return Promise.resolve(OK({ summary: SUMMARY_DTO, stale: true }));
      }
      return defaultInvoke()(channel, {});
    });
    renderScreen();

    const badge = await screen.findByTestId('insight-stale-badge');
    // Сохранённый разбор показан сразу (последнее по периоду — §5 «история не нужна»).
    expect(screen.getByTestId('insight-summary-text').textContent).toContain('Сохранённый разбор');
    fireEvent.click(badge);

    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));
  });

  it('без сохранённого разбора — обучающая подсказка вместо пустоты', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/summary/latest') {
        return Promise.resolve(OK(undefined));
      }
      return defaultInvoke()(channel, {});
    });
    renderScreen();

    expect(await screen.findByTestId('insight-empty')).toBeDefined();
  });
});

describe('InsightScreen — BUSY и модель не настроена (§13/AC-5.4)', () => {
  it('BUSY-отказ канала — тост-подсказка «генерация уже идёт» (§13)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/summary/generate') {
        return Promise.resolve(FAIL('AI/BUSY', 'errors.AI_BUSY'));
      }
      return defaultInvoke()(channel, {});
    });
    renderScreen();

    fireEvent.click(await screen.findByTestId('insight-generate'));

    await waitFor(() =>
      expect(screen.getByTestId('toast-region').textContent).toContain('Генерация уже идёт'),
    );
  });

  it('модель не настроена → CTA-карточка вместо кнопки генерации; CTA ведёт на вкладку «Модель» (AC-5.4)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS({ aiSettings: { dismissed: true, includeNotes: false } })));
      }
      return defaultInvoke()(channel, {});
    });
    const onGoToModel = vi.fn();
    renderScreen({ onGoToModel });

    const cta = await screen.findByTestId('insight-model-cta');
    expect(cta.textContent).toContain('Модель');
    expect(screen.queryByTestId('insight-generate')).toBeNull();

    fireEvent.click(screen.getByTestId('insight-model-cta-go'));
    expect(onGoToModel).toHaveBeenCalledTimes(1);
  });
});

describe('InsightScreen — гонки генерации (§13)', () => {
  it('смена периода во время генерации → авто-cancel текущей', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('insight-period-7d'));

    await waitFor(() => expect(payloadsOf('ai/cancel')[0]).toEqual({ requestId: 'r1' }));
  });

  it('уход с экрана во время генерации → cancel (useEffect-cleanup)', async () => {
    const { unmount } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/?tab=insight'] },
        createElement(
          ToastProvider,
          null,
          createElement(
            QueryClientProvider,
            { client: createQueryClient() },
            createElement(InsightScreen, { onGoToModel: () => undefined }),
          ),
        ),
      ),
    );
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    unmount();

    await waitFor(() => expect(payloadsOf('ai/cancel')[0]).toEqual({ requestId: 'r1' }));
  });
});

describe('InsightScreen — «Очистить разборы» (§5: видимая, с подтверждением)', () => {
  it('подтверждение → ai/summary/delete-all invoke; отмена — без вызова', async () => {
    renderScreen();

    fireEvent.click(await screen.findByTestId('insight-clear'));
    const dialog = screen.getByTestId('insight-clear-dialog');
    expect(dialog.textContent).toContain('Очистить');

    fireEvent.click(screen.getByTestId('insight-clear-cancel'));
    expect(screen.queryByTestId('insight-clear-dialog')).toBeNull();
    expect(payloadsOf('ai/summary/delete-all')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('insight-clear'));
    fireEvent.click(screen.getByTestId('insight-clear-confirm'));
    await waitFor(() => expect(payloadsOf('ai/summary/delete-all')).toHaveLength(1));
  });
});

describe('InsightScreen — производительность стрима (§15)', () => {
  it('1000 токенов fake аппендятся за < 2 с UI-времени, текст полный', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('insight-generate'));
    await waitFor(() => expect(payloadsOf('ai/summary/generate')).toHaveLength(1));

    const startedAt = Date.now();
    for (let index = 0; index < 1000; index += 1) {
      emit('ai:token', { requestId: 'r1', text: `т${index} ` });
    }

    const text = await screen.findByTestId('insight-summary-text');
    expect(text.textContent).toContain('т999 ');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
