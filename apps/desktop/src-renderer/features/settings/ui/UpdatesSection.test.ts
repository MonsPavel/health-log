/**
 * TASK-097 §5/§13/§16/§19/§20: DOM-тесты секции «Обновления» (мок каналов и событий):
 *  - статус-строки по фикстурам состояния (idle/checking/available/latest/error — §19);
 *  - без согласия кнопка «Проверить» ведёт к инлайн-подсказке (не ошибка, §13),
 *    invoke updates/check НЕ вызван (AC2); с согласием — invoke (§13);
 *  - полный цикл с моками: check→available→download (прогресс из события
 *    update:progress)→ready→install confirm→invoke (AC3);
 *  - confirm-диалог установки: Esc = отмена, invoke не вызван (AC4);
 *  - бета-канал: select disabled с подписью «появится вместе с каналом beta» (AC5);
 *  - версия приложения — из userAgent (§5 упрощение, прецедент app-version.test);
 *  - «Проверено: {время}» — localStorage hl.updates.lastCheckAt после успешной
 *    проверки (§5 «локальное состояние», префикс hl. — стирается при wipe 072).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdatesSection } from './UpdatesSection';

import '../../../i18n';

type InvokeMock = ReturnType<typeof vi.fn<(channel: string) => Promise<unknown>>>;

let invoke: InvokeMock;
let listeners: Map<string, (payload: unknown) => void>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const PREFS = (consent: boolean) => ({
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: consent, modelsDownload: false },
  autoLockMin: 5,
});

/** Ответ канала updates/check по умолчанию (фикстуры переопределяют). */
let checkData: unknown;
/** Отложенный резолв updates/download — для проверки прогресса до финала. */
let resolveDownload: ((data: unknown) => void) | undefined;

interface HlOptions {
  readonly consent?: boolean;
}

/** Мост: prefs (согласие), updates/*; события update:* — captured-слушатели useHlEvent. */
function makeHl(options: HlOptions = {}): void {
  listeners = new Map();
  checkData = { status: 'latest' };
  resolveDownload = undefined;
  invoke = vi.fn((channel: string) => {
    if (channel === 'prefs/get') {
      return Promise.resolve(OK(PREFS(options.consent ?? false)));
    }
    if (channel === 'updates/check') {
      return Promise.resolve(OK(checkData));
    }
    if (channel === 'updates/download') {
      return new Promise((resolve) => {
        resolveDownload = (data: unknown) => resolve(OK(data));
      });
    }
    if (channel === 'updates/install') {
      return Promise.resolve(OK({ restarting: true }));
    }
    return Promise.resolve(OK(null));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return () => undefined;
      }),
    },
  });
}

/** Эмуляция события main→renderer (§11: update:available/progress/ready). */
function fire(name: string, payload: unknown): void {
  act(() => {
    listeners.get(name)?.(payload);
  });
}

/** userAgent хвост «Name/version» — источник строки версии (§5 упрощение). */
function stubUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua });
}

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(UpdatesSection), { wrapper });
}

/**
 * Клик «Проверить» с ожиданием активации: пока prefs не загружены, кнопка
 * disabled (гейт согласия неизвестен, §10) — прецедент SettingsScreen.test.
 */
async function clickCheck(): Promise<void> {
  const button = await screen.findByTestId('updates-check');
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('UpdatesSection — статус-строки по фикстурам состояния (§19/AC1)', () => {
  it('idle: секция, версия из UA, «Проверено: никогда», кнопка активна (§5)', async () => {
    // Реальный layout UA Electron: токен приложения перед « Chrome/» (ревью 097).
    stubUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) health-log/1.2.3 Chrome/126.0.0.0 Electron/33.0.0 Safari/537.36',
    );
    makeHl({ consent: true });
    renderSection();

    expect(screen.getByRole('heading', { name: 'Обновления' })).toBeDefined();
    expect(screen.getByTestId('updates-version').textContent).toContain('1.2.3');
    expect(await screen.findByTestId('updates-lastcheck').then((el) => el.textContent)).toContain(
      'никогда',
    );
    expect(screen.queryByTestId('updates-consent-hint')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('updates-check').hasAttribute('disabled')).toBe(false),
    );
  });

  it('checking: «Проверяем…», кнопка «Проверить» disabled (§10 статус-машина)', async () => {
    makeHl({ consent: true });
    invoke.mockImplementation((channel: string) =>
      channel === 'updates/check'
        ? new Promise(() => undefined) // проверка висит — состояние checking
        : Promise.resolve(OK(PREFS(true))),
    );
    renderSection();
    await clickCheck();

    expect(await screen.findByText('Проверяем…')).toBeDefined();
    expect(screen.getByTestId('updates-check').hasAttribute('disabled')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('updates/check', {});
  });

  it('available: «Доступна версия 1.1.0» + кнопка «Скачать» (§5 карточка)', async () => {
    makeHl({ consent: true });
    checkData = { status: 'available', version: '1.1.0' };
    renderSection();
    await clickCheck();

    expect(await screen.findByText('Доступна версия 1.1.0')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Скачать' })).toBeDefined();
    // «Установить» до скачивания не существует (§10: нельзя установить до ready).
    expect(screen.queryByTestId('updates-install')).toBeNull();
  });

  it('latest: «У вас последняя версия»; «Проверено: {время}» + localStorage (§5)', async () => {
    const fixedNowMs = Date.UTC(2026, 0, 15, 9, 30);
    vi.spyOn(Date, 'now').mockReturnValue(fixedNowMs);
    makeHl({ consent: true });
    checkData = { status: 'latest' };
    renderSection();
    await clickCheck();

    expect(await screen.findByText('У вас последняя версия')).toBeDefined();
    expect(await screen.findByTestId('updates-lastcheck').then((el) => el.textContent)).toMatch(
      /Проверено: \d{2}\.\d{2}\.\d{4}/,
    );
    expect(localStorage.getItem('hl.updates.lastCheckAt')).toBe(String(fixedNowMs));
  });

  it('error: «Не удалось проверить обновления», кнопка снова активна (§9/AC1)', async () => {
    makeHl({ consent: true });
    checkData = { status: 'error' };
    renderSection();
    await clickCheck();

    expect(await screen.findByText('Не удалось проверить обновления')).toBeDefined();
    await waitFor(() =>
      expect(screen.getByTestId('updates-check').hasAttribute('disabled')).toBe(false),
    );
  });
});

describe('UpdatesSection — согласие на сетевой доступ (§13/AC2)', () => {
  it('без согласия: клик ведёт к подсказке «Приватность», invoke НЕ вызван (§13)', async () => {
    makeHl({ consent: false });
    renderSection();
    await clickCheck();

    const hint = await screen.findByTestId('updates-consent-hint');
    expect(hint.textContent).toContain('Приватность');
    expect(invoke).not.toHaveBeenCalledWith('updates/check', {});
    // Подсказка — статус, не ошибка (§13 «не ошибка»): нет role="alert".
    expect(hint.getAttribute('role')).toBe('status');
  });

  it('с согласием: клик вызывает updates/check {} (§13)', async () => {
    makeHl({ consent: true });
    renderSection();
    await clickCheck();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('updates/check', {}));
    expect(screen.queryByTestId('updates-consent-hint')).toBeNull();
  });
});

describe('UpdatesSection — полный цикл: check→available→download(прогресс)→ready→install (AC3)', () => {
  it('прогресс из события update:progress; установка — после confirm-диалога (AC3)', async () => {
    makeHl({ consent: true });
    checkData = { status: 'available', version: '1.1.0' };
    renderSection();

    await clickCheck();
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать' }));

    // Прогресс приходит СОБЫТИЕМ (§10/§12), пока download висит.
    fire('update:progress', { percent: 42.4 });
    const progress = await screen.findByRole('progressbar');
    expect(progress.getAttribute('aria-valuenow')).toBe('42');
    expect(progress.getAttribute('aria-valuemax')).toBe('100');
    // Статус не только цветом (§16): процент текстом.
    expect(screen.getByTestId('updates-progress-text').textContent).toContain('42');

    resolveDownload?.({ status: 'ready', version: '1.1.0' });
    fireEvent.click(await screen.findByTestId('updates-install'));

    // Confirm-диалог: «Приложение перезапустится» (§13), Esc/отмена — дефолт.
    const dialog = await screen.findByTestId('updates-install-dialog');
    expect(dialog.textContent).toContain('Приложение перезапустится');
    fireEvent.click(await screen.findByTestId('updates-install-confirm'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('updates/install', {}));
  });

  it('confirm: Esc = отмена — диалог закрыт, updates/install НЕ вызван (AC4)', async () => {
    makeHl({ consent: true });
    checkData = { status: 'available', version: '1.1.0' };
    renderSection();

    await clickCheck();
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать' }));
    // mutationFn стартует асинхронно — ждём, пока отложенный резолв появится.
    await waitFor(() => expect(resolveDownload).toBeDefined());
    resolveDownload?.({ status: 'ready', version: '1.1.0' });
    fireEvent.click(await screen.findByTestId('updates-install'));
    await screen.findByTestId('updates-install-dialog');

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('updates-install-dialog')).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith('updates/install', {});
  });

  it('отказ установки: инлайн-ошибка, кнопка «Установить» остаётся (§10)', async () => {
    makeHl({ consent: true });
    checkData = { status: 'available', version: '1.1.0' };
    invoke.mockImplementation((channel: string) => {
      if (channel === 'updates/check') {
        return Promise.resolve(OK(checkData));
      }
      if (channel === 'updates/download') {
        return Promise.resolve(OK({ status: 'ready', version: '1.1.0' }));
      }
      if (channel === 'updates/install') {
        return Promise.resolve({
          v: 1,
          ok: false,
          error: { code: 'UPD/NOT_READY', messageKey: 'errors.UPD_NOT_READY' },
        });
      }
      return Promise.resolve(OK(PREFS(true)));
    });
    renderSection();

    await clickCheck();
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать' }));
    fireEvent.click(await screen.findByTestId('updates-install'));
    fireEvent.click(await screen.findByTestId('updates-install-confirm'));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByTestId('updates-install')).toBeDefined();
  });
});

describe('UpdatesSection — бета-канал: заготовка TASK-107 (§5/AC5)', () => {
  it('select disabled с подписью «каналом beta» (AC5)', () => {
    makeHl();
    renderSection();

    const select = screen.getByLabelText('Канал обновлений');
    expect(select.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('updates-beta-soon').textContent).toContain('каналом beta');
  });

  it('событие update:available переключает карточку без запроса (§12 события)', async () => {
    makeHl({ consent: true });
    renderSection();
    await screen.findByTestId('updates-lastcheck');
    // Seed запроса (idle, §12) должен устояться ДО события — иначе его ответ
    // перезапишет setQueryData события (гонка микротасок, тестовая — в бою seed
    // резолвится при монтировании, события приходят позже).
    await act(() => Promise.resolve(undefined));

    fire('update:available', { version: '2.0.0' });

    // Нотификация наблюдателей React Query асинхронна — ждём (как в полном цикле).
    expect(await screen.findByText('Доступна версия 2.0.0')).toBeDefined();
  });

  it('снапшот переживает размонтирование секции и возврат после gcTime (ревью 097)', async () => {
    vi.useFakeTimers();
    makeHl({ consent: true });
    checkData = { status: 'available', version: '1.1.0' };
    // ЕДИНЫЙ клиент на оба монтажа — как в бою (провайдер живёт с окном).
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const first = render(createElement(UpdatesSection), { wrapper });
    await clickCheck();
    expect(await screen.findByText('Доступна версия 1.1.0')).toBeDefined();
    // Навигация уходит с настроек — секция размонтируется (app/router.tsx);
    // продовый QueryClient собирает кэш через 10 минут простоя
    // (lib/query-client.ts gcTime). Снапшот main сессионный (updates-service
    // держит его в памяти до перезапуска) — возврат обязан показать available,
    // а не seed idle: повторный сетевой цикл не нужен (§2/§3).
    first.unmount();
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000 + 1_000);
    });

    render(createElement(UpdatesSection), { wrapper });
    expect(await screen.findByText('Доступна версия 1.1.0')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Скачать' })).toBeDefined();
  });
});
