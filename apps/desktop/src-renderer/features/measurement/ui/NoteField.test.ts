/**
 * TASK-031 §5/§16/§19: тест поля заметки — textarea ≤500 с счётчиком;
 * maxlength из СХЕМЫ (NOTE_MAX, единая истина — извлечение max_length);
 * ошибка: aria-invalid + aria-describedby (§16).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { NoteField } from './NoteField';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NoteField — заметка ≤500 с счётчиком (§5)', () => {
  it('textarea подписана «Заметка», maxlength = NOTE_MAX из схемы (500)', () => {
    render(createElement(NoteField, { value: '', onChange: vi.fn() }));

    const area = screen.getByRole('textbox', { name: 'Заметка' }) as HTMLTextAreaElement;
    expect(area.maxLength).toBe(500);
  });

  it('ввод вызывает onChange с новым значением', () => {
    const onChange = vi.fn();
    render(createElement(NoteField, { value: '', onChange }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Заметка' }), {
      target: { value: 'после прогулки' },
    });

    expect(onChange).toHaveBeenCalledWith('после прогулки');
  });

  it('счётчик показывает длину: «14/500»', () => {
    render(createElement(NoteField, { value: 'после прогулки', onChange: vi.fn() }));

    expect(screen.getByText('14/500')).toBeDefined();
  });

  it('пустая заметка: «0/500»', () => {
    render(createElement(NoteField, { value: '', onChange: vi.fn() }));

    expect(screen.getByText('0/500')).toBeDefined();
  });

  it('ошибка: aria-invalid + aria-describedby с текстом (§16)', () => {
    render(
      createElement(NoteField, {
        value: '',
        onChange: vi.fn(),
        error: { messageKey: 'errors.noteTooLong', params: { max: 500 } },
      }),
    );

    const area = screen.getByRole('textbox', { name: 'Заметка' });
    expect(area.getAttribute('aria-invalid')).toBe('true');
    const describedBy = area.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const message = document.getElementById(describedBy ?? '');
    expect(message?.textContent).toContain('Заметка слишком длинная');
  });
});
