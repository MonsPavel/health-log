/**
 * TASK-073 §5/§13/§14/§17/§19: тесты диалога создания копии (BackupDialog).
 * Матрица:
 *  - предупреждение «Забыли пароль — данные копии невосстановимы» присутствует
 *    ВСЕГДА (§14: обязательный элемент; §17: отдельный ключ — тест текста);
 *  - мисматч двух вводов → инлайн-ошибка, onSubmit НЕ вызван (§19);
 *  - политика ≥8 символов — ПРЕДУПРЕЖДЕНИЕ, отправка не блокируется (§13: main
 *    не блокирует, contracts data-care/schemas.ts);
 *  - валидный ввод → onSubmit(passphrase); поля type=password (§14);
 *  - isBusy → кнопка отправки недоступна (§10);
 *  - «Отмена» → onClose (safe-action, §16).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackupDialog, type BackupDialogProps } from './BackupDialog';

import '../../../../i18n';

afterEach(() => {
  cleanup();
});

function renderDialog(props: Partial<BackupDialogProps> = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    createElement(BackupDialog, {
      open: true,
      isBusy: false,
      onSubmit,
      onClose,
      ...props,
    }) as ReactElement,
  );
  return { onSubmit, onClose };
}

const passphrase = (): HTMLInputElement =>
  screen.getByLabelText('Пароль копии') as HTMLInputElement;
const passphraseRepeat = (): HTMLInputElement =>
  screen.getByLabelText('Повторите пароль') as HTMLInputElement;
const submit = (): HTMLElement => screen.getByRole('button', { name: 'Создать копию' });

describe('BackupDialog — создание копии (TASK-073 §19)', () => {
  it('предупреждение о забытой пароле присутствует всегда (§14: обязательный элемент — тест текста)', () => {
    renderDialog();

    expect(screen.getByText('Забыли пароль — данные копии невосстановимы.')).toBeDefined();
  });

  it('мисматч паролей → инлайн-ошибка, onSubmit не вызван (§19)', () => {
    renderDialog();

    fireEvent.change(passphrase(), { target: { value: 'пароль-один' } });
    fireEvent.change(passphraseRepeat(), { target: { value: 'пароль-другой' } });
    fireEvent.click(submit());

    expect(screen.getByText('Пароли не совпадают.')).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('политика ≥8 — предупреждение, но отправка НЕ блокируется (§13: main не блокирует, UI предупреждает)', () => {
    const { onSubmit } = renderDialog();

    fireEvent.change(passphrase(), { target: { value: 'короткий' } });
    fireEvent.change(passphraseRepeat(), { target: { value: 'короткий' } });
    fireEvent.click(submit());

    expect(
      screen.getByText('Короткий пароль легче подобрать — рекомендуется не менее 8 символов.'),
    ).toBeDefined();
    expect(onSubmit).toHaveBeenCalledWith('короткий');
  });

  it('валидный ввод → onSubmit(passphrase); поля type=password (§14)', () => {
    const { onSubmit } = renderDialog();

    expect(passphrase().getAttribute('type')).toBe('password');
    expect(passphraseRepeat().getAttribute('type')).toBe('password');

    fireEvent.change(passphrase(), { target: { value: 'пароль-копии-073' } });
    fireEvent.change(passphraseRepeat(), { target: { value: 'пароль-копии-073' } });
    fireEvent.click(submit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('пароль-копии-073');
  });

  it('isBusy: кнопка отправки недоступна (§10: одна операция одновременно)', () => {
    renderDialog({ isBusy: true });

    expect(submit().hasAttribute('disabled')).toBe(true);
  });

  it('«Отмена» → onClose (safe-action по умолчанию, §16)', () => {
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
