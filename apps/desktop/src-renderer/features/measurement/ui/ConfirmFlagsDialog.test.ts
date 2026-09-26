/**
 * TASK-032 §19: юниты ConfirmFlagsDialog — рендер подсказок из флагов-фикстур
 * (typo-only, duplicate-only, оба, оба+critical; срочность первой — §13), клик
 * «Оставить» → onKeep без delete, «Удалить и исправить» → onDeleteFix, Esc → keep
 * (безопасное действие по умолчанию — §10/§16), опасная кнопка НЕ в автофокусе (§10),
 * фокус-ловушка (Tab зациклен — §16/§19), axe без critical (§16, прецедент формы).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementFlags } from '@hl/contracts';

import '../../../i18n';
import { ConfirmFlagsDialog } from './ConfirmFlagsDialog';

/** Фикстуры флагов §19: typo-only, duplicate-only, оба, оба+critical. */
const TYPO_ONLY: MeasurementFlags = {
  duplicate: false,
  typo: { field: 'sys', median: 128, value: 258, deviation: 130 },
};
const DUPLICATE_ONLY: MeasurementFlags = { duplicate: true };
const BOTH: MeasurementFlags = {
  duplicate: true,
  typo: { field: 'dia', median: 82, value: 28, deviation: 54 },
};
const BOTH_PLUS_CRITICAL: MeasurementFlags = {
  duplicate: true,
  typo: { field: 'sys', median: 128, value: 200, deviation: 72 },
  criticalValue: 'high',
};

function renderDialog(
  flags: MeasurementFlags,
  handlers: { onKeep?: () => void; onDeleteFix?: () => void } = {},
): void {
  render(
    createElement(ConfirmFlagsDialog, {
      open: true,
      flags,
      onKeep: handlers.onKeep ?? (() => undefined),
      onDeleteFix: handlers.onDeleteFix ?? (() => undefined),
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe('ConfirmFlagsDialog — подсказки из флагов (§19/§17)', () => {
  it('typo-only: подсказка с подстановками median/value/field, без дубля и срочности', () => {
    renderDialog(TYPO_ONLY);

    const hint = screen.getByTestId('hint-typo');
    expect(hint.textContent).toContain('Обычно около 128');
    expect(hint.textContent).toContain('258');
    // field интерполируется локализованной подписью поля (sys → «Верхнее (СДА)»).
    expect(hint.textContent).toContain('Верхнее (СДА)');
    expect(screen.queryByTestId('hint-duplicate')).toBeNull();
    expect(screen.queryByTestId('hint-critical')).toBeNull();
  });

  it('typo в поле dia: подпись поля «Нижнее (ДДА)»', () => {
    renderDialog({
      duplicate: false,
      typo: { field: 'dia', median: 82, value: 28, deviation: 54 },
    });

    expect(screen.getByTestId('hint-typo').textContent).toContain('Нижнее (ДДА)');
  });

  it('duplicate-only: подсказка дубля, typo-подсказки нет', () => {
    renderDialog(DUPLICATE_ONLY);

    expect(screen.getByTestId('hint-duplicate').textContent).toContain('Такая запись уже есть');
    expect(screen.queryByTestId('hint-typo')).toBeNull();
    expect(screen.queryByTestId('hint-critical')).toBeNull();
  });

  it('оба флага: одна карточка с двумя строками — typo и duplicate (§13, не два диалога)', () => {
    renderDialog(BOTH);

    expect(screen.getByTestId('hint-typo')).toBeDefined();
    expect(screen.getByTestId('hint-duplicate')).toBeDefined();
    // Ровно один диалог (role="dialog" один).
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('оба+critical: секция срочности первой, до typo-подсказки (§13)', () => {
    renderDialog(BOTH_PLUS_CRITICAL);

    const critical = screen.getByTestId('hint-critical');
    const typo = screen.getByTestId('hint-typo');
    expect(critical.textContent).toContain('Давление ≥180/120 может быть опасным');
    // Порядок в DOM: typo следует ЗА critical → critical первый (§13 — срочность первой).
    expect(critical.compareDocumentPosition(typo) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});

describe('ConfirmFlagsDialog — кнопки и Esc (§19/§10)', () => {
  it('клик «Оставить» → onKeep, onDeleteFix не вызван (без delete)', () => {
    const onKeep = vi.fn();
    const onDeleteFix = vi.fn();
    renderDialog(BOTH, { onKeep, onDeleteFix });

    fireEvent.click(screen.getByTestId('dialog-keep'));

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDeleteFix).not.toHaveBeenCalled();
  });

  it('клик «Удалить и исправить» → onDeleteFix, onKeep не вызван', () => {
    const onKeep = vi.fn();
    const onDeleteFix = vi.fn();
    renderDialog(BOTH, { onKeep, onDeleteFix });

    fireEvent.click(screen.getByTestId('dialog-delete-fix'));

    expect(onDeleteFix).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it('Esc → onKeep (безопасное действие по умолчанию, §10/§16), onDeleteFix не вызван', async () => {
    const user = userEvent.setup();
    const onKeep = vi.fn();
    const onDeleteFix = vi.fn();
    renderDialog(BOTH, { onKeep, onDeleteFix });

    await user.keyboard('{Escape}');

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDeleteFix).not.toHaveBeenCalled();
  });
});

describe('ConfirmFlagsDialog — фокус (§10/§16/§19)', () => {
  it('при открытии опасная кнопка НЕ в автофокусе; фокус внутри диалога', () => {
    renderDialog(BOTH);

    const deleteFix = screen.getByTestId('dialog-delete-fix');
    expect(document.activeElement).not.toBe(deleteFix);
    // Фокус не снаружи: либо сам диалог, либо элемент внутри него.
    const dialog = screen.getByTestId('confirm-flags-dialog');
    expect(document.activeElement === dialog || dialog.contains(document.activeElement)).toBe(true);
  });

  it('фокус-ловушка: Tab многократно не выводит фокус из диалога (§19)', async () => {
    const user = userEvent.setup();
    renderDialog(BOTH_PLUS_CRITICAL);
    const dialog = screen.getByTestId('confirm-flags-dialog');

    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // Обратный порядок тоже зациклен.
    for (let i = 0; i < 6; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('role="dialog" с доступным именем из заголовка (§16 aria-labelledby)', () => {
    renderDialog(BOTH);

    expect(screen.getByRole('dialog', { name: 'Проверьте значения' })).toBeDefined();
  });
});

describe('ConfirmFlagsDialog — axe (§16, прецедент формы TASK-031)', () => {
  it('axe.run: violations с impact=critical отсутствуют', async () => {
    // Radix Dialog рендерит через Portal в document.body — скан честно по body
    // (в тесте body содержит только диалог).
    render(
      createElement(ConfirmFlagsDialog, {
        open: true,
        flags: BOTH_PLUS_CRITICAL,
        onKeep: () => undefined,
        onDeleteFix: () => undefined,
      }),
    );

    const results = await axe.run(document.body);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
