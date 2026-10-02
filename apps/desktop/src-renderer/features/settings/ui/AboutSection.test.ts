/**
 * TASK-100 §19/§20: DOM-тесты секции «О приложении» (мок каналов 100):
 *  - AC «все версии видны»: строки версий — приложение/схема БД/шкала code+version/
 *    модель id+version/время старта (definition-list семантика — §16);
 *  - модель не выбрана → строки нет (§5 «если есть»);
 *  - статус-блок сампроверки: зелёный при healthy-отчёте, красный бейдж с деталями
 *    при dbOk=false (§10/§19);
 *  - кнопка «Полная проверка БД»: запуск (pending, disabled) → результат ok; отказ —
 *    красный текст + details (мок долгой операции — deferred-промис, §19);
 *  - null-отчёт (самчек не выполнялся) — честный нейтральный статус (§11).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppMetaResponse, SelfCheckReport } from '@hl/contracts';

import '../../../i18n';
import { AboutSection } from './AboutSection';

type InvokeMock = ReturnType<typeof vi.fn<(channel: string) => Promise<unknown>>>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const META: AppMetaResponse = {
  appVersion: '0.1.0',
  schemaVersion: 9,
  scale: { code: 'BP-OFFICE-ESC2018', version: '1.0.0' },
  model: { id: 'qwen3-4b', version: '1.0' },
};

const HEALTHY: SelfCheckReport = {
  dbOk: true,
  schemaVersion: 9,
  vaultMode: 'none',
  worker: { state: 'starting' },
  prefsOk: true,
  checkedAtUtc: Date.UTC(2026, 0, 15, 9, 30),
  startupMs: 12,
};

const CORRUPT: SelfCheckReport = {
  ...HEALTHY,
  dbOk: false,
};

interface HlOptions {
  readonly meta?: AppMetaResponse;
  readonly report?: SelfCheckReport | null;
  /** Deferred-резолв полной проверки (мок long-операции §19). */
  readonly deferIntegrity?: (resolve: (data: unknown) => void) => void;
}

let invoke: InvokeMock;

function makeHl(options: HlOptions = {}): void {
  const meta = options.meta ?? META;
  const report = 'report' in options ? options.report : HEALTHY;
  invoke = vi.fn((channel: string) => {
    if (channel === 'app/meta') {
      return Promise.resolve(OK(meta));
    }
    if (channel === 'app/selfcheck') {
      return Promise.resolve(OK(report));
    }
    if (channel === 'app/integrity-full') {
      return options.deferIntegrity === undefined
        ? Promise.resolve(OK({ ok: true, details: 'ok' }))
        : new Promise((resolve) => {
            options.deferIntegrity?.((data: unknown) => resolve(OK(data)));
          });
    }
    return Promise.resolve(OK(null));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
}

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(AboutSection), { wrapper });
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('AboutSection — строки версий (TASK-100 §5/§19, AC «О приложении»)', () => {
  it('все версии видны: приложение/схема/шкала code+version/модель id+version/время старта', async () => {
    makeHl();
    renderSection();

    const list = await screen.findByTestId('about-versions');
    expect(list.tagName).toBe('DL'); // §16: definition-list семантика

    // Квери каналов асинхронны — ждём фактического появления версий (§19).
    await waitFor(() =>
      expect(screen.getByTestId('about-version-app').textContent).toContain('0.1.0'),
    );
    expect(screen.getByTestId('about-version-schema').textContent).toContain('9');
    expect(screen.getByTestId('about-version-scale').textContent).toContain('BP-OFFICE-ESC2018');
    expect(screen.getByTestId('about-version-scale').textContent).toContain('1.0.0');
    expect(screen.getByTestId('about-version-model').textContent).toContain('qwen3-4b');
    expect(screen.getByTestId('about-version-model').textContent).toContain('1.0');
    expect(screen.getByTestId('about-startup').textContent).toContain('12');
  });

  it('модель не выбрана — строка модели отсутствует, остальные на месте', async () => {
    makeHl({ meta: { ...META, model: undefined } });
    renderSection();

    // Ждём загрузки версий (квери асинхронны): строка приложения появилась —
    // строки модели нет (модель не выбрана), остальные на месте.
    await waitFor(() =>
      expect(screen.getByTestId('about-version-app').textContent).toContain('0.1.0'),
    );
    expect(screen.queryByTestId('about-version-model')).toBeNull();
    expect(screen.getByTestId('about-version-scale').textContent).toContain('BP-OFFICE-ESC2018');
  });
});

describe('AboutSection — статус сампроверки (§5/§10/§19)', () => {
  it('healthy-отчёт → зелёный статус (текст+иконка §16), без деталей', async () => {
    makeHl({ report: HEALTHY });
    renderSection();

    const status = await screen.findByTestId('about-selfcheck-status');
    await waitFor(() => expect(status.getAttribute('data-state')).toBe('ok'));
    expect(status.textContent).toContain('Проблем не обнаружено');
    expect(screen.queryByTestId('about-selfcheck-details')).toBeNull();
  });

  it('dbOk=false → красный бейдж с деталями (повреждение БД)', async () => {
    makeHl({ report: CORRUPT });
    renderSection();

    const status = await screen.findByTestId('about-selfcheck-status');
    await waitFor(() => expect(status.getAttribute('data-state')).toBe('failed'));
    expect(status.textContent).toContain('Обнаружены проблемы');
    const details = screen.getByTestId('about-selfcheck-details');
    expect(details.textContent).toContain('повреждение');
    // §10: красный статус читается скринридером (live-область).
    expect(status.parentElement?.getAttribute('aria-live')).toBe('polite');
  });

  it('null-отчёт (самчек не выполнялся) — нейтральный честный статус', async () => {
    makeHl({ report: null });
    renderSection();

    const status = await screen.findByTestId('about-selfcheck-status');
    expect(status.getAttribute('data-state')).toBe('pending');
  });
});

describe('AboutSection — полная проверка БД (§4/§11/§19, AC4)', () => {
  it('запуск → pending (disabled, aria-busy) → результат ok', async () => {
    let resolveIntegrity: ((data: unknown) => void) | undefined;
    makeHl({
      deferIntegrity: (resolve) => {
        resolveIntegrity = resolve;
      },
    });
    renderSection();

    const button = await screen.findByTestId('about-full-check');
    fireEvent.click(button);

    // Долгая операция: pending-статус и блокировка повторного запуска.
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('about-full-check-running')).not.toBeNull();

    act(() => {
      resolveIntegrity?.({ ok: true, details: 'ok' });
    });
    const result = await screen.findByTestId('about-full-check-result');
    expect(result.textContent).toContain('ошибок не найдено');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('повторный запуск заменяет результат (AC4 «инвалидация»: отдельный результат в UI, §7)', async () => {
    const deferred: Array<(data: unknown) => void> = [];
    makeHl({
      deferIntegrity: (resolve) => {
        deferred.push(resolve);
      },
    });
    renderSection();

    const button = await screen.findByTestId('about-full-check');

    // Первый запуск → отказ.
    fireEvent.click(button);
    await waitFor(() => expect(deferred).toHaveLength(1));
    act(() => {
      deferred[0]?.({ ok: false, details: 'page 7 broken' });
    });
    const failed = await screen.findByTestId('about-full-check-result');
    expect(failed.getAttribute('data-state')).toBe('failed');

    // Повторный запуск → ok: предыдущий результат замещён (mutation data).
    fireEvent.click(button);
    await waitFor(() => expect(deferred).toHaveLength(2));
    act(() => {
      deferred[1]?.({ ok: true, details: 'ok' });
    });
    const okResult = await screen.findByTestId('about-full-check-result');
    expect(okResult.getAttribute('data-state')).toBe('ok');
    expect(okResult.textContent).toContain('ошибок не найдено');
    expect(screen.queryByTestId('about-full-check-details')).toBeNull();
  });

  it('повреждённая БД → красный результат с текстом integrity_check (details)', async () => {
    makeHl({
      report: CORRUPT,
      deferIntegrity: undefined,
    });
    invoke.mockImplementation((channel: string) => {
      if (channel === 'app/meta') {
        return Promise.resolve(OK(META));
      }
      if (channel === 'app/selfcheck') {
        return Promise.resolve(OK(CORRUPT));
      }
      if (channel === 'app/integrity-full') {
        return Promise.resolve(
          OK({ ok: false, details: '*** in database main: On tree page 12: invalid page type' }),
        );
      }
      return Promise.resolve(OK(null));
    });
    renderSection();

    fireEvent.click(await screen.findByTestId('about-full-check'));
    const result = await screen.findByTestId('about-full-check-result');
    expect(result.getAttribute('data-state')).toBe('failed');
    expect(screen.getByTestId('about-full-check-details').textContent).toContain(
      'invalid page type',
    );
  });
});
