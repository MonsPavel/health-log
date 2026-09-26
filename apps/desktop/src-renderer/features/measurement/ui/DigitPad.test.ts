/**
 * TASK-031 §5/§16/§19: тест цифровой клавиатуры — 0–9, backspace, очистить;
 * ввод кликами (клавиатурный ввод — через фокус-поля в тестах формы);
 * aria-label цифр («Ввести 5», §16); цели нажатия ≥44px (класс min-h-11,
 * rem — масштабируется с FR-8.2).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { DigitPad } from './DigitPad';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPad(
  handlers: { onDigit?: (d: string) => void; onBackspace?: () => void; onClear?: () => void } = {},
): void {
  render(
    createElement(DigitPad, {
      onDigit: handlers.onDigit ?? vi.fn(),
      onBackspace: handlers.onBackspace ?? vi.fn(),
      onClear: handlers.onClear ?? vi.fn(),
    }),
  );
}

describe('DigitPad — кнопки и обратные вызовы (§5)', () => {
  it('клик по цифре 5 вызывает onDigit("5")', () => {
    const onDigit = vi.fn();
    renderPad({ onDigit });

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 5' }));

    expect(onDigit).toHaveBeenCalledWith('5');
  });

  it('клик по backspace вызывает onBackspace', () => {
    const onBackspace = vi.fn();
    renderPad({ onBackspace });

    fireEvent.click(screen.getByRole('button', { name: 'Удалить последнюю цифру' }));

    expect(onBackspace).toHaveBeenCalledTimes(1);
  });

  it('клик по «Очистить» вызывает onClear', () => {
    const onClear = vi.fn();
    renderPad({ onClear });

    fireEvent.click(screen.getByRole('button', { name: 'Очистить поле' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('все десять цифр доступны по aria-label «Ввести N» (§16)', () => {
    renderPad();
    for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(screen.getByRole('button', { name: `Ввести ${digit}` })).toBeDefined();
    }
  });
});

describe('DigitPad — a11y: цели нажатия ≥44px (§16, NFR-6)', () => {
  it('кнопки цифр и действий несут класс min-h-11 (2.75rem = 44px)', () => {
    renderPad();

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(12);
    for (const button of buttons) {
      expect(button.className).toContain('min-h-11');
    }
  });
});
