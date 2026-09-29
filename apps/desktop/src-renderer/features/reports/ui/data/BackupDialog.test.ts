/**
 * TASK-073 §5/§13/§14/§17/§19/§20: тесты диалога создания копии (BackupDialog).
 * Матрица (§19): пароль-мисматч → инлайн-ошибка БЕЗ вызова канала; пустой пароль —
 * инлайн-ошибка; политика ≥8 — предупреждение, НЕ блокировка (§13 070); обязательное
 * предупреждение «Забыли пароль — данные копии невосстановимы» (§14 — тест текста);
 * поля type=password (§14); успех → канал backup/create {mode:'ask', passphrase} +
 * тост с basename (ответ канала — basename, §14); BACKUP/CANCELED — тихо (§7);
 * BACKUP/FAILED — инлайн-ошибка, диалог открыт; Esc — безопасное действие (§16);
 * фокус при открытии — в «Отмене»; axe — без critical (§20).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope } from '@hl/contracts';

import '../../../../i18n';
import { BackupDialog } from './BackupDialog';

/** Мост `window.hl` с журналом вызовов (§19, прецедент ExportButtons.test). */
const invoke = vi.fn<(channel: string, payload: unknown) => Promise<ApiEnvelope<unknown>>>();

beforeEach(() => {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

/**
 * Рендер с харнессом-владельцем модальности (зеркало DataSection): onClose реально
 * закрывает диалог — поведение «диалог закрыт после успеха/отмены» проверяется честно.
 */
function renderDialog(onCloseSpy: () => void = () => undefined): void {
  const client = new QueryClient();
  function Harness(): JSX.Element {
    const [open, setOpen] = useState(true);
    return createElement(BackupDialog, {
      open,
      onClose: () => {
        onCloseSpy();
        setOpen(false);
      },
    });
  }
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Harness) as ReactElement,
    ) as ReactNode,
  );
}

const pass1 = (): HTMLInputElement => screen.getByTestId('data-backup-passphrase');
const pass2 = (): HTMLInputElement => screen.getByTestId('data-backup-passphrase-repeat');
const submit = (): HTMLButtonElement => screen.getByTestId('data-backup-submit');

function fillPasswords(first: string, second: string): void {
  fireEvent.change(pass1(), { target: { value: first } });
  fireEvent.change(pass2(), { target: { value: second } });
}

const okCreated = (): ApiEnvelope<unknown> => ({
  v: 1,
  ok: true,
  data: {
    file: 'health-log-backup-20260925T160000.hlbackup',
    sizeBytes: 2048,
    manifest: { formatVersion: 1, counts: { measurements: 3 } },
  },
});
const canceledEnvelope = (): ApiEnvelope<unknown> => ({
  v: 1,
  ok: false,
  error: { code: 'BACKUP/CANCELED', messageKey: 'errors.BACKUP_CANCELED' },
});
const failedEnvelope = (): ApiEnvelope<unknown> => ({
  v: 1,
  ok: false,
  error: { code: 'BACKUP/FAILED', messageKey: 'errors.BACKUP_FAILED' },
});

describe('BackupDialog — обязательное предупреждение и форма пароля (§14)', () => {
  it('предупреждение «Забыли пароль — данные копии невосстановимы» присутствует всегда (тест текста)', () => {
    renderDialog();

    expect(screen.getByTestId('data-backup-forgot-warning').textContent).toBe(
      'Забыли пароль — данные копии невосстановимы.',
    );
  });

  it('оба поля — type=password (§14: пароль не отображается)', () => {
    renderDialog();

    expect(pass1().getAttribute('type')).toBe('password');
    expect(pass2().getAttribute('type')).toBe('password');
  });

  it('подсказка политики ≥8 появляется при коротком пароле и исчезает при достаточном (§5/§13)', () => {
    renderDialog();

    expect(screen.queryByTestId('data-backup-policy-warning')).toBeNull();
    fireEvent.change(pass1(), { target: { value: 'коротко' } });
    expect(screen.getByTestId('data-backup-policy-warning').textContent).toContain('8');
    fireEvent.change(pass1(), { target: { value: 'длинный-пароль' } });
    expect(screen.queryByTestId('data-backup-policy-warning')).toBeNull();
  });
});

describe('BackupDialog — валидация до канала (§19: мисматч → инлайн-ошибка)', () => {
  it('пароли не совпадают → инлайн-ошибка, канал НЕ вызван', () => {
    renderDialog();
    fillPasswords('пароль-копии-1', 'пароль-копии-2');

    fireEvent.click(submit());

    expect(screen.getByTestId('data-backup-error').textContent).toBe('Пароли не совпадают.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('пустой пароль → инлайн-ошибка, канал НЕ вызван', () => {
    renderDialog();

    fireEvent.click(submit());

    expect(screen.getByTestId('data-backup-error').textContent).toBe('Введите пароль копии.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('короткий пароль (политика — предупреждение, не блокировка §13 070) → канал вызван', async () => {
    renderDialog();
    fillPasswords('коротко', 'коротко');

    fireEvent.click(submit());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('backup/create', { mode: 'ask', passphrase: 'коротко' }),
    );
  });
});

describe('BackupDialog — исходы канала backup/create (§7/§10/§14)', () => {
  it('успех → {mode: ask, passphrase}; тост с basename; диалог закрыт (AC-2.4)', async () => {
    invoke.mockResolvedValue(okCreated());
    renderDialog();
    fillPasswords('пароль-копии', 'пароль-копии');

    fireEvent.click(submit());

    await waitFor(() => expect(screen.getByRole('status')).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('backup/create', {
      mode: 'ask',
      passphrase: 'пароль-копии',
    });
    // Тост — basename файла (ответ канала — basename, §14); полного пути нет.
    const toast = screen.getByRole('status');
    expect(toast.textContent).toBe('Копия сохранена: health-log-backup-20260925T160000.hlbackup');
    expect(screen.queryByTestId('data-backup-dialog')).toBeNull();
  });

  it('BACKUP/CANCELED (отказ диалога сохранения) — тихо: тоста нет, диалог закрыт (§7)', async () => {
    invoke.mockResolvedValue(canceledEnvelope());
    renderDialog();
    fillPasswords('пароль-копии', 'пароль-копии');

    fireEvent.click(submit());

    await waitFor(() => expect(screen.queryByTestId('data-backup-dialog')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('BACKUP/FAILED — инлайн-ошибка канона каталога errors.*, диалог остаётся открыт (§10)', async () => {
    invoke.mockResolvedValue(failedEnvelope());
    renderDialog();
    fillPasswords('пароль-копии', 'пароль-копии');

    fireEvent.click(submit());

    await waitFor(() =>
      expect(screen.getByTestId('data-backup-error').textContent).toBe(
        'Не удалось выполнить операцию с копией. Попробуйте ещё раз.',
      ),
    );
    expect(screen.queryByTestId('data-backup-dialog')).not.toBeNull();
  });
});

describe('BackupDialog — доступность (§16/§20)', () => {
  it('Esc = безопасное действие: onClose, канал не вызван', async () => {
    const onClose = vi.fn();
    const client = new QueryClient();
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BackupDialog, { open: true, onClose }) as ReactElement,
      ) as ReactNode,
    );
    await waitFor(() => expect(screen.getByTestId('data-backup-dialog')).toBeDefined());

    fireEvent.keyDown(screen.getByTestId('data-backup-dialog'), { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('фокус при открытии — в безопасной кнопке «Отмена» (§16: safe-action дефолт)', async () => {
    renderDialog();

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('data-backup-cancel')),
    );
  });

  it('axe — violations с impact=critical отсутствуют (§20)', async () => {
    renderDialog();
    const dialog = (await waitFor(() =>
      document.querySelector('[data-testid="data-backup-dialog"]'),
    )) as HTMLElement;

    // Axe по поддереву Content (портал Radix живёт в body — мимо фокус-гардов).
    const results = await axe.run(dialog);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});
