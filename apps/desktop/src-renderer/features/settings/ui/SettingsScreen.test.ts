/**
 * TASK-049 §19/§20: DOM-тесты экрана настроек — простой/продвинутый режим:
 *  - AC-1: чистый запуск (prefs.advancedMode=false) — продвинутая секция ОТСУТСТВУЕТ
 *    из DOM (§16: условный рендер, не visibility:hidden); переключатель «Простой
 *    режим» — checked (§13: по умолчанию ВКЛ);
 *  - AC-2: отключение простого режима → prefs/set {patch:{advancedMode:true}},
 *    секция «Продвинутые» видна (формат даты в DOM); включение обратно → секции
 *    нет, формат даты сохранился (§13: toggle туда-сюда не сбрасывает);
 *  - AC-3: перезапуск после включения — режим сохранён (prefs — источник).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { SettingsScreen } from './SettingsScreen';

let invoke: ReturnType<typeof vi.fn>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const PREFS = (over: Record<string, unknown> = {}) => ({
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
  ...over,
});

function renderScreen(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(SettingsScreen)),
  );
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK(PREFS()));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
  localStorage.clear();
});

describe('SettingsScreen — простой/продвинутый режим (TASK-049 §5/§13/§16)', () => {
  it('чистый запуск: продвинутой секции нет в DOM; «Простой режим» включён (AC-1)', async () => {
    renderScreen();

    const sw = await screen.findByRole('switch', { name: 'Простой режим' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('advanced-section')).toBeNull();
    // Формат даты — содержимое продвинутой секции: тоже удалён из DOM (§16).
    expect(screen.queryByLabelText('Формат даты')).toBeNull();
  });

  it('отключение простого режима: prefs/set advancedMode:true → секция видна, формат даты в DOM (AC-2)', async () => {
    renderScreen();
    const sw = await screen.findByRole('switch', { name: 'Простой режим' });

    invoke.mockResolvedValueOnce(OK(PREFS({ advancedMode: true })));
    fireEvent.click(sw);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { advancedMode: true } }),
    );
    expect(await screen.findByTestId('advanced-section')).toBeDefined();
    expect(screen.getByLabelText<HTMLSelectElement>('Формат даты')).toBeDefined();
    // aria-checked отражает «Простой режим»: продвинутый включён → switch снят.
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
  });

  it('выключение обратно: секции нет; повторное включение — формат даты прежний (§13, AC-2)', async () => {
    invoke.mockResolvedValue(OK(PREFS({ advancedMode: true, dateFormat: 'mdy' })));
    renderScreen();
    expect(await screen.findByTestId('advanced-section')).toBeDefined();

    invoke.mockResolvedValueOnce(OK(PREFS({ advancedMode: false, dateFormat: 'mdy' })));
    fireEvent.click(screen.getByRole('switch', { name: 'Простой режим' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { advancedMode: false } }),
    );
    await waitFor(() => expect(screen.queryByTestId('advanced-section')).toBeNull());
    expect(screen.queryByLabelText('Формат даты')).toBeNull();

    // Туда-сюда (§13): значение формата не сбросилось.
    invoke.mockResolvedValueOnce(OK(PREFS({ advancedMode: true, dateFormat: 'mdy' })));
    fireEvent.click(screen.getByRole('switch', { name: 'Простой режим' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('prefs/set', { patch: { advancedMode: true } }),
    );
    await screen.findByTestId('advanced-section');
    expect(screen.getByLabelText<HTMLSelectElement>('Формат даты').value).toBe('mdy');
  });

  it('перезапуск после включения: режим сохранён — секция сразу видна (AC-3)', async () => {
    invoke.mockResolvedValue(OK(PREFS({ advancedMode: true, dateFormat: 'dmy' })));

    renderScreen();

    // Свежий монтаж читает сохранённый prefs: секция есть без кликов.
    expect(await screen.findByTestId('advanced-section')).toBeDefined();
    const select = (await screen.findByLabelText('Формат даты')) as HTMLSelectElement;
    expect(select.value).toBe('dmy');
    expect(screen.getByRole('switch', { name: 'Простой режим' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });
});
