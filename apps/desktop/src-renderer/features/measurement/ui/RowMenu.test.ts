/**
 * TASK-038 §5/§16/§19: тест меню строки. Триггер ⋮ с aria-haspopup="menu" и
 * доступным именем; открытие показывает «Изменить»/«Удалить»; выбор пункта
 * вызывает соответствующий колбэк и закрывает меню; Esc закрывает без действий
 * (радиофокус-возврат в строку делает Radix — фокус возвращается триггеру).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { RowMenu } from './RowMenu';

afterEach(() => {
  cleanup();
});

describe('RowMenu — триггер (§16)', () => {
  it('кнопка ⋮: доступное имя, aria-haspopup="menu", data-row-menu для фокус-возврата', () => {
    render(createElement(RowMenu, { measurementId: 'm-1', onEdit: () => undefined, onDelete: () => undefined }));

    const trigger = screen.getByRole('button', { name: 'Действия с записью' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('data-row-menu')).toBe('m-1');
    expect(trigger.textContent).toBe('⋮');
  });

  it('закрытое меню пунктов не рендерит', () => {
    render(createElement(RowMenu, { measurementId: 'm-1', onEdit: () => undefined, onDelete: () => undefined }));

    expect(screen.queryByTestId('row-menu-content')).toBeNull();
  });
});

describe('RowMenu — открытие и выбор (§5/§19)', () => {
  it('клик по триггеру открывает меню: «Изменить» и «Удалить»', async () => {
    const user = userEvent.setup();
    render(createElement(RowMenu, { measurementId: 'm-1', onEdit: () => undefined, onDelete: () => undefined }));

    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));

    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());
    expect(screen.getByTestId('row-menu-edit').textContent).toBe('Изменить');
    expect(screen.getByTestId('row-menu-delete').textContent).toBe('Удалить');
  });

  it('«Изменить» → onEdit вызван, onDelete нет; меню закрылось (§5)', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(createElement(RowMenu, { measurementId: 'm-1', onEdit, onDelete }));
    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));
    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());

    await user.click(screen.getByTestId('row-menu-edit'));

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(onDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('row-menu-content')).toBeNull());
  });

  it('«Удалить» → onDelete вызван, onEdit нет (§5)', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(createElement(RowMenu, { measurementId: 'm-2', onEdit, onDelete }));
    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));
    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());

    await user.click(screen.getByTestId('row-menu-delete'));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('Esc закрывает меню без вызова действий (§16: Esc = отмена)', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(createElement(RowMenu, { measurementId: 'm-1', onEdit, onDelete }));
    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));
    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());

    fireEvent.keyDown(screen.getByTestId('row-menu-content'), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('row-menu-content')).toBeNull());
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    // Радиофокус-возврат (§16): фокус вернулся в триггер строки.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-row-menu')).toBe('m-1'),
    );
  });
});
