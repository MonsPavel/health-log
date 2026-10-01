/**
 * TASK-090 §19/§20: компонентные тесты экрана «Чат» (мок-каналы, прецедент
 * InsightScreen.test.ts 088):
 *  - инициализация: ai/chat/list {profileId, limit} → лента (user/assistant/
 *    refusal-стили, §5);
 *  - отправка (Enter + кнопка) — invoke с периодом; оптимистичный user-бабл
 *    сразу (§12); пустой вопрос → кнопка disabled (§13);
 *  - Shift+Enter — перенос, не отправка (§5);
 *  - стрим: ai:token аппендится в виртуальный assistant-бабл (§10); финал —
 *    invalidate ['chat', pid], виртуальная пара заменяется сохранённой (§12);
 *  - финал без messageId (cancel) — виртуальная пара исчезает (частичный ответ
 *    не сохраняется, §5 089);
 *  - BUSY (ok:false AI/BUSY) — тост «Дождитесь завершения…» (§13), прочие
 *    ошибки канала — тост по каталогу;
 *  - генерация: ввод disabled + «Стоп» → ai/cancel (§5);
 *  - чипы: вставляют текст в поле, НЕ отправляют (§5); пустая лента →
 *    empty-state с чипами;
 *  - «Очистить чат»: отмена — история цела; подтверждение — clear invoke,
 *    лента пустеет, empty-state (§13);
 *  - модель не настроена → CTA-карточка вместо ввода (§5, как 088);
 *  - a11y-атрибуты: role="log" aria-live="polite", label поля (§16);
 *  - прерывание (ai:status ready без финала) — блок ошибки + «Повторить»
 *    (прецедент 088 §5).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { ChatMessageDto, HlEventMap } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { createQueryClient } from '../../../lib/query-client';
import { ChatScreen } from './ChatScreen';

/** Типизированный мок моста: канал → Promise (no-misused-promises, §19). */
type InvokeMock = ReturnType<typeof vi.fn<(channel: string, payload: unknown) => Promise<unknown>>>;

let invoke: InvokeMock;
// Мост хранит ВСЕ подписки на имя (реальный доставляет каждой) — useHlEvent
// подписывает ai:token/ai:status/ai/chat/result + prefs/models-события.
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

/** История чата, которую отдаёт мок ai/chat/list (тесты мутируют до refetch). */
let history: readonly ChatMessageDto[];

const MSG_USER: ChatMessageDto = {
  id: 'm1',
  role: 'user',
  content: 'Как менялось давление?',
  createdAtUtc: 1000,
};
const MSG_ASSISTANT: ChatMessageDto = {
  id: 'm2',
  role: 'assistant',
  content: 'Давление стабильное.\n\nЭто не медицинская консультация.',
  createdAtUtc: 1000,
};
const MSG_REFUSAL: ChatMessageDto = {
  id: 'm3',
  role: 'assistant',
  content: 'Я не буду советовать препараты.\n\nЭто не медицинская консультация.',
  refusalClass: 'treatment',
  createdAtUtc: 2000,
};

function defaultInvoke(): InvokeMock {
  return vi
    .fn<(channel: string, payload: unknown) => Promise<unknown>>()
    .mockImplementation((channel: string) => {
      if (channel === 'ai/chat/list') {
        return Promise.resolve(OK({ messages: history }));
      }
      if (channel === 'ai/models/list') {
        return Promise.resolve(OK(LIST_INSTALLED));
      }
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS()));
      }
      if (channel === 'ai/chat/send') {
        return Promise.resolve(OK({ requestId: 'r1' }));
      }
      if (channel === 'ai/chat/clear') {
        return Promise.resolve(OK({ cleared: true }));
      }
      if (channel === 'ai/cancel') {
        return Promise.resolve(OK({ cancelled: true }));
      }
      return Promise.resolve(OK({}));
    });
}

function renderScreen(options: { onGoToModel?: () => void } = {}): void {
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/?tab=chat'] },
      createElement(
        ToastProvider,
        null,
        createElement(
          QueryClientProvider,
          { client: createQueryClient() },
          createElement(ChatScreen, {
            onGoToModel: options.onGoToModel ?? (() => undefined),
          }),
        ),
      ),
    ),
  );
}

/** Вызовы канала моста: [channel, payload] (типизированный мок — один аргумент). */
const payloadsOf = (channel: string): unknown[] =>
  invoke.mock.calls
    .filter((entry) => entry[0] === channel)
    .map((entry) => (entry as unknown as unknown[])[1]);

/** Токен/финал/статус активной генерации — в подписки моста (useHlEvent). */
const emit = (name: keyof HlEventMap, payload: unknown): void => {
  for (const listener of eventListeners[name] ?? []) {
    listener(payload);
  }
};

/** Баблы ленты (history + оптимистичная пара); queryAll — пустая лента валидна. */
const bubbles = (): HTMLElement[] => screen.queryAllByTestId('chat-bubble');

const typeQuestion = async (text: string): Promise<HTMLTextAreaElement> => {
  const input = await screen.findByTestId('chat-input');
  fireEvent.change(input, { target: { value: text } });
  return input as HTMLTextAreaElement;
};

beforeEach(() => {
  history = [];
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

describe('ChatScreen — инициализация истории (§5 ai/chat/list)', () => {
  it('монтирование: invoke ai/chat/list {profileId, limit}; лента рендерит историю', async () => {
    history = [MSG_USER, MSG_ASSISTANT, MSG_REFUSAL];
    renderScreen();

    await waitFor(() =>
      expect(payloadsOf('ai/chat/list')[0]).toEqual({
        profileId: 'seed-profile-0001',
        limit: 200,
      }),
    );
    await waitFor(() => expect(bubbles()).toHaveLength(3));
    const kinds = bubbles().map((bubble) => bubble.getAttribute('data-kind'));
    expect(kinds).toEqual(['user', 'assistant', 'refusal']);
    // Отказ — серый стиль + info-иконка (§5); обычный assistant — без иконки.
    expect(screen.getByTestId('chat-refusal-icon')).toBeDefined();
  });

  it('пустая история → empty-state с подсказкой и тремя чипами (§5)', async () => {
    renderScreen();

    await screen.findByTestId('chat-empty');
    expect(screen.getByText('О чём спросить? Например:')).toBeDefined();
    expect(screen.getAllByTestId('chat-chip')).toHaveLength(3);
  });
});

describe('ChatScreen — отправка вопроса (Enter + кнопка, §5/§13)', () => {
  it('кнопка «Отправить»: invoke ai/chat/send {profileId, question, period:30d}; user-бабл сразу', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');

    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(payloadsOf('ai/chat/send')[0]).toEqual({
        profileId: 'seed-profile-0001',
        question: 'Как менялось давление?',
        period: '30d',
      }),
    );
    // Оптимистичный user-бабл отображается сразу (§12), за ним виртуальный assistant.
    await waitFor(() => expect(bubbles()).toHaveLength(2));
    expect(bubbles()[0]?.getAttribute('data-kind')).toBe('user');
    expect(bubbles()[0]?.textContent).toContain('Как менялось давление?');
    expect(bubbles()[1]?.getAttribute('data-kind')).toBe('assistant');
  });

  it('Enter отправляет; Shift+Enter переносит (не отправляет) (§5/§20)', async () => {
    renderScreen();
    const input = await typeQuestion('Как менялось давление?');

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(payloadsOf('ai/chat/send')).toHaveLength(0);
    // Браузер вставил перенос (onChange), отправки нет.
    fireEvent.change(input, { target: { value: 'Как менялось давление?\n' } });
    expect(payloadsOf('ai/chat/send')).toHaveLength(0);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(1));
    // trim на клиенте: оптимистичный бабл совпадает с сохранённым (схема канала тоже trim, §13 089).
    expect(payloadsOf('ai/chat/send')[0]).toMatchObject({ question: 'Как менялось давление?' });
  });

  it('пустой вопрос → кнопка disabled (§13)', async () => {
    renderScreen();
    const send = await screen.findByTestId('chat-send');
    expect((send as HTMLButtonElement).disabled).toBe(true);

    await typeQuestion('   ');
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('выбор периода уходит в send (локальный state, дефолт 30d → 7d/custom, §5/§12)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('chat-period-7d'));
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(payloadsOf('ai/chat/send')[0]).toMatchObject({ period: '7d' }),
    );
    // Завершаем первый ход (финал без messageId — cancel): фаза idle, ввод активен.
    emit('ai/chat/result', { requestId: 'r1' });
    await waitFor(() => expect(bubbles()).toHaveLength(0));

    fireEvent.click(screen.getByTestId('chat-period-custom'));
    fireEvent.change(screen.getByTestId('filter-range-from'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByTestId('filter-range-to'), { target: { value: '2026-03-08' } });
    await typeQuestion('А за эту неделю?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(payloadsOf('ai/chat/send')[1]).toMatchObject({
        period: { fromUtcMs: expect.any(Number), toUtcMs: expect.any(Number) },
      }),
    );
  });

  it('чипы вставляют текст в поле и НЕ отправляют (§5/§19)', async () => {
    renderScreen();
    await screen.findByTestId('chat-input');

    fireEvent.click(screen.getAllByTestId('chat-chip')[0] as HTMLElement);

    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(
      'Как менялось давление?',
    );
    expect(payloadsOf('ai/chat/send')).toHaveLength(0);
  });
});

describe('ChatScreen — стрим, финал, отмена (§10/§12)', () => {
  it('токены аппендятся в виртуальный assistant-бабл (§10)', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(1));

    emit('ai:token', { requestId: 'r1', text: 'Давление ' });
    await waitFor(() => expect(bubbles()[1]?.textContent).toContain('Давление'));
    emit('ai:token', { requestId: 'r1', text: 'стабильное.' });
    await waitFor(() => expect(bubbles()[1]?.textContent).toContain('стабильное.'));
    // Виртуальный бабл — ещё не сохранённая запись: лента = 2 (пара), история не refetch.
    expect(bubbles()).toHaveLength(2);
  });

  it('финал с messageId: invalidate → refetch, виртуальная пара заменяется сохранённой (§12)', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(1));

    const listCallsBefore = payloadsOf('ai/chat/list').length;
    history = [MSG_USER, MSG_ASSISTANT];
    emit('ai/chat/result', { requestId: 'r1', messageId: 'm2' });

    await waitFor(() => {
      expect(payloadsOf('ai/chat/list').length).toBeGreaterThan(listCallsBefore);
    });
    await waitFor(() => expect(bubbles()).toHaveLength(2));
    // Сохранённая пара (из refetch) вместо виртуальной — тексты совпадают без дублей.
    expect(bubbles()[0]?.textContent).toContain('Как менялось давление?');
    expect(bubbles()[1]?.textContent).toContain('Давление стабильное.');
  });

  it('финал без messageId (cancel): виртуальная пара исчезает — частичный ответ не сохранён (§5 089)', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(bubbles()).toHaveLength(2));

    emit('ai/chat/result', { requestId: 'r1' });

    await waitFor(() => expect(bubbles()).toHaveLength(0));
    await screen.findByTestId('chat-empty');
  });

  it('«Стоп» во время генерации → ai/cancel invoke по requestId (§5)', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('chat-stop'));

    await waitFor(() => expect(payloadsOf('ai/cancel')[0]).toEqual({ requestId: 'r1' }));
  });

  it('генерация: ввод disabled, «Отправить» заменён на «Стоп» (§5/§13); после финала — снова активен', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(1));

    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByTestId('chat-send')).toBeNull();
    expect(screen.getByTestId('chat-stop').textContent).toBe('Стоп');

    emit('ai/chat/result', { requestId: 'r1', messageId: 'm2' });

    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(screen.getByTestId('chat-send')).toBeDefined();
    expect(screen.queryByTestId('chat-stop')).toBeNull();
  });
});

describe('ChatScreen — BUSY и ошибки канала (§13)', () => {
  it('BUSY (ok:false AI/BUSY) — тост «Дождитесь завершения текущей генерации.» (§13)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/chat/send') {
        return Promise.resolve(FAIL('AI/BUSY', 'errors.AI_BUSY'));
      }
      return defaultInvoke()(channel, {});
    });
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('toast-region').textContent).toContain(
        'Дождитесь завершения текущей генерации',
      ),
    );
    // Оптимистичный user-бабл при ошибке удаления из ленты (§12).
    await waitFor(() => expect(bubbles()).toHaveLength(0));
  });

  it('прочая ошибка канала — тост по каталогу ошибок (dto)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/chat/send') {
        return Promise.resolve(FAIL('AI/ENGINE_NOT_CONFIGURED', 'errors.AI_ENGINE_NOT_CONFIGURED'));
      }
      return defaultInvoke()(channel, {});
    });
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('toast-region').textContent).toContain('Модель не выбрана'),
    );
  });
});

describe('ChatScreen — очистка истории (§5/§13)', () => {
  it('отмена диалога: clear НЕ вызван, история цела (§20)', async () => {
    history = [MSG_USER, MSG_ASSISTANT];
    renderScreen();
    await screen.findByTestId('chat-feed');

    fireEvent.click(screen.getByTestId('chat-clear'));
    const dialog = await screen.findByTestId('chat-clear-dialog');
    expect(dialog.textContent).toContain('История будет удалена необратимо.');
    fireEvent.click(screen.getByTestId('chat-clear-cancel'));

    expect(payloadsOf('ai/chat/clear')).toHaveLength(0);
    expect(screen.queryByTestId('chat-clear-dialog')).toBeNull();
    expect(screen.getAllByTestId('chat-bubble')).toHaveLength(2);
  });

  it('подтверждение: clear invoke → лента пустеет, empty-state с чипами (§13/§20)', async () => {
    history = [MSG_USER, MSG_ASSISTANT];
    renderScreen();
    await screen.findByTestId('chat-feed');

    fireEvent.click(screen.getByTestId('chat-clear'));
    await screen.findByTestId('chat-clear-dialog');
    history = [];
    fireEvent.click(screen.getByTestId('chat-clear-confirm'));

    await waitFor(() => expect(payloadsOf('ai/chat/clear')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('chat-bubble')).toBeNull());
    await screen.findByTestId('chat-empty');
    expect(screen.getAllByTestId('chat-chip')).toHaveLength(3);
  });
});

describe('ChatScreen — модель не настроена (§5, как 088 AC-5.4)', () => {
  it('CTA-карточка вместо ввода; переход на вкладку «Модель» (§5)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS({ aiSettings: { dismissed: true, includeNotes: false } })));
      }
      return defaultInvoke()(channel, {});
    });
    const onGoToModel = vi.fn<() => void>();
    renderScreen({ onGoToModel });

    const cta = await screen.findByTestId('chat-model-cta');
    expect(cta.textContent).toContain('Модель ещё не настроена');
    expect(screen.queryByTestId('chat-input')).toBeNull();
    expect(screen.queryByTestId('chat-send')).toBeNull();

    fireEvent.click(screen.getByTestId('chat-model-cta-go'));
    expect(onGoToModel).toHaveBeenCalledTimes(1);
  });
});

describe('ChatScreen — a11y-атрибуты (§16)', () => {
  it('лента role="log" aria-live="polite"; поле ввода связано с label', async () => {
    renderScreen();

    const feed = await screen.findByTestId('chat-feed');
    expect(feed.getAttribute('role')).toBe('log');
    expect(feed.getAttribute('aria-live')).toBe('polite');

    // Композер появляется после загрузки prefs/models (без вспышки, §5 081).
    const input = await screen.findByTestId('chat-input');
    expect(screen.getByLabelText('Ваш вопрос')).toBe(input);
    // Дисклеймер-футер несъёмный (§5/§14).
    expect(screen.getByTestId('chat-disclaimer').textContent).toContain(
      'Это не медицинская консультация.',
    );
  });
});

describe('ChatScreen — прерывание без финала (прецедент 088 §5)', () => {
  it('ai:status ready без финала → блок ошибки; «Повторить» заново вызывает send', async () => {
    renderScreen();
    await typeQuestion('Как менялось давление?');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(1));

    emit('ai:status', { state: 'ready', requestId: 'r1' });

    const error = await screen.findByTestId('chat-error');
    expect(error.textContent).toContain('Генерация прервана');
    expect(bubbles()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('chat-retry'));
    await waitFor(() => expect(payloadsOf('ai/chat/send')).toHaveLength(2));
    expect(payloadsOf('ai/chat/send')[1]).toMatchObject({
      question: 'Как менялось давление?',
      period: '30d',
    });
  });
});
