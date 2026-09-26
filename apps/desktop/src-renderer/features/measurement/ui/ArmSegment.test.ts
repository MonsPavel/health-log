/**
 * TASK-031 §5/§16/§19: тест сегмент-контрола руки — native radio (левая/правая,
 * стрелки — нативная семантика), fieldset/legend, выбор меняет onArm.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { ArmSegment } from './ArmSegment';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ArmSegment — сегмент-контрол руки (§5/§16)', () => {
  it('правая рука выбрана по умолчанию (начальный стенд store)', () => {
    render(createElement(ArmSegment, { value: 'right', onArm: vi.fn() }));

    const left = screen.getByRole('radio', { name: 'Левая' }) as HTMLInputElement;
    const right = screen.getByRole('radio', { name: 'Правая' }) as HTMLInputElement;
    expect(right.checked).toBe(true);
    expect(left.checked).toBe(false);
  });

  it('клик по «Левая» вызывает onArm("left")', () => {
    const onArm = vi.fn();
    render(createElement(ArmSegment, { value: 'right', onArm }));

    fireEvent.click(screen.getByRole('radio', { name: 'Левая' }));

    expect(onArm).toHaveBeenCalledWith('left');
  });

  it('выбранная рука отражается checked (value → UI)', () => {
    render(createElement(ArmSegment, { value: 'left', onArm: vi.fn() }));

    const left = screen.getByRole('radio', { name: 'Левая' }) as HTMLInputElement;
    expect(left.checked).toBe(true);
  });

  it('группа подписана легендой «Рука» (fieldset/legend, §16)', () => {
    render(createElement(ArmSegment, { value: 'right', onArm: vi.fn() }));

    // fieldset доступен как group с именем легенды.
    expect(screen.getByRole('group', { name: 'Рука' })).toBeDefined();
  });

  it('цели нажатия ≥44px: подписи радиокнопок несут класс min-h-11 (§16)', () => {
    render(createElement(ArmSegment, { value: 'right', onArm: vi.fn() }));

    for (const label of ['Левая', 'Правая']) {
      const input = screen.getByRole('radio', { name: label });
      const labelEl = input.closest('label');
      expect(labelEl?.className).toContain('min-h-11');
    }
  });
});
