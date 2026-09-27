/**
 * TASK-038 §5/§16/§19: тест подтверждения удаления (Radix AlertDialog).
 * Заголовок «Удалить запись от {дата} {время}?» — дата/время настенные из Instant
 * записи; тело «необратимо» (FR-2.3); фокус при открытии — в безопасной кнопке
 * «Отмена» (§16); Esc = отмена (запись на месте); «Удалить» → onConfirm;
 * axe — без critical-нарушений (§20).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import '../../../i18n';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

/** Запись-цель: Instant 2026-09-24 18:30 UTC @ +180 → настенная 24.09.2026 21:30. */
function targetDto(overrides: Partial<MeasurementDto> = {}): MeasurementDto {
  return {
    id: 'm-1',
    profileId: 'seed-profile-0001',
    sys: 125,
    dia: 82,
    irregularPulse: false,
    arm: 'right',
    takenAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    tzOffsetMin: 180,
    source: 'manual',
    createdAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    updatedAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
    ...overrides,
  };
}

function renderDialog(
  target: MeasurementDto | null,
  handlers: { readonly onConfirm?: () => void; readonly onClose?: () => void } = {},
): void {
  render(
    createElement(DeleteConfirmDialog, {
      target,
      onConfirm: handlers.onConfirm ?? (() => undefined),
      onClose: handlers.onClose ?? (() => undefined),
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DeleteConfirmDialog — тексты (§5/§17)', () => {
  it('заголовок с настенными датой и временем записи; тело — «необратимо»', () => {
    renderDialog(targetDto());

    const title = screen.getByTestId('delete-confirm-title');
    expect(title.textContent).toContain('Удалить запись от');
    expect(title.textContent).toContain('24.09.2026');
    expect(title.textContent).toContain('21:30');
    expect(screen.getByTestId('delete-confirm-body').textContent).toContain('необратимо');
  });

  it('закрытый диалог (target null) не рендерится', () => {
    renderDialog(null);

    expect(screen.queryByTestId('delete-confirm-dialog')).toBeNull();
  });
});

describe('DeleteConfirmDialog — решения (§5/§16)', () => {
  it('фокус при открытии — в безопасной кнопке «Отмена» (§16)', async () => {
    renderDialog(targetDto());

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('delete-cancel')));
  });

  it('«Отмена» → onClose, onConfirm НЕ вызван — запись на месте (§20)', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    renderDialog(targetDto(), { onConfirm, onClose });

    fireEvent.click(screen.getByTestId('delete-cancel'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc → onClose (отмена), onConfirm НЕ вызван (§16: Esc = отмена)', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    renderDialog(targetDto(), { onConfirm, onClose });
    await waitFor(() => expect(screen.getByTestId('delete-confirm-dialog')).toBeDefined());

    fireEvent.keyDown(screen.getByTestId('delete-confirm-dialog'), { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('«Удалить» → onConfirm вызван (§5: подтверждение → measurements/delete)', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    renderDialog(targetDto(), { onConfirm, onClose });

    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
});

describe('DeleteConfirmDialog — axe (§20)', () => {
  it('violations с impact=critical отсутствуют', async () => {
    const { container } = render(
      createElement(DeleteConfirmDialog, {
        target: targetDto(),
        onConfirm: () => undefined,
        onClose: () => undefined,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('delete-confirm-dialog')).toBeDefined());

    const results = await axe.run(container);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});
