/**
 * TASK-073 §5/§10/§13/§19/§20: тесты мастер-флоу восстановления (RestoreFlow) —
 * один диалог, шаги файл → пароль → план → рестарт-экран (§10).
 * Матрица: выбор файла через канал file/open-dialog с фильтром .hlbackup (отмена —
 * тихо, §7); шаг пароля — поле пустое (предзаполнения нет, §13); план рендерится с
 * предупреждениями и счётчиками («В копии 350 записей, сейчас — 120», §13 071);
 * чекбокс-гейт — кнопка execute мертва без чекбокса (§13 — защита от Enter-спама);
 * execute → рестарт-экран role=alert (§16), диалог закрыт; неверный пароль —
 * инлайн-ошибка, флоу не падает (AC3); DB_NEWER — текст с параметром версии;
 * «Назад» до execute (§10); Esc — безопасное действие; axe — без critical.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope, BackupRestorePlan } from '@hl/contracts';

import '../../../../i18n';
import { RestoreFlow } from './RestoreFlow';

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

function renderFlow(open = true, onClose: () => void = () => undefined): void {
  const client = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RestoreFlow, { open, onClose }) as ReactElement,
    ) as ReactNode,
  );
}

/** Открыть флоу и пройти к шагу плана (мок: файл выбран, план получен). */
async function renderAtPlan(plan: BackupRestorePlan): Promise<void> {
  invoke.mockImplementation((channel: string) => {
    if (channel === 'file/open-dialog') {
      return Promise.resolve({ v: 1, ok: true, data: { path: 'C:\\copies\\x.hlbackup' } });
    }
    return Promise.resolve({ v: 1, ok: true, data: { plan } });
  });
  renderFlow();
  fireEvent.click(screen.getByTestId('data-restore-pick'));
  await waitFor(() => expect(screen.getByTestId('data-restore-passphrase')).toBeDefined());
  fireEvent.change(screen.getByTestId('data-restore-passphrase'), {
    target: { value: 'пароль-копии' },
  });
  fireEvent.click(screen.getByTestId('data-restore-next'));
  await waitFor(() => expect(screen.getByTestId('data-restore-plan')).toBeDefined());
}

const PLAN: BackupRestorePlan = {
  schemaVersion: 4,
  schemaDelta: 'older',
  createdAtUtc: Date.UTC(2026, 8, 25, 16, 0),
  counts: { measurements: 350 },
  currentCounts: { measurements: 120 },
  warnings: ['replaces-current', 'older-than-current'],
};

describe('RestoreFlow — шаг 1: выбор файла (§5: файл-пикер через канал)', () => {
  it('клик → file/open-dialog с фильтром .hlbackup; файл выбран → шаг пароля, поле пустое (§13)', async () => {
    invoke.mockResolvedValue({ v: 1, ok: true, data: { path: 'C:\\copies\\x.hlbackup' } });
    renderFlow();

    fireEvent.click(screen.getByTestId('data-restore-pick'));

    const input = (await waitFor(() =>
      screen.getByTestId('data-restore-passphrase'),
    )) as HTMLInputElement;
    expect(invoke).toHaveBeenCalledWith('file/open-dialog', {
      filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
    });
    expect(input.value).toBe('');
  });

  it('отмена диалога выбора → тихо: остаёмся на шаге файла, ошибок нет (§7)', async () => {
    invoke.mockResolvedValue({ v: 1, ok: true, data: { canceled: true } });
    renderFlow();

    fireEvent.click(screen.getByTestId('data-restore-pick'));

    await waitFor(() =>
      expect((screen.getByTestId('data-restore-pick') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId('data-restore-passphrase')).toBeNull();
    expect(screen.queryByTestId('data-restore-error')).toBeNull();
  });
});

describe('RestoreFlow — шаг 2: пароль → план (§5/§13 071)', () => {
  it('«Продолжить» → backup/restore {file, passphrase, confirmed:false}; план рендерится (AC2)', async () => {
    await renderAtPlan(PLAN);

    expect(invoke).toHaveBeenCalledWith('backup/restore', {
      file: 'C:\\copies\\x.hlbackup',
      passphrase: 'пароль-копии',
      confirmed: false,
    });
    const planArea = screen.getByTestId('data-restore-plan');
    expect(planArea.textContent).toContain('В копии 350 записей, сейчас — 120');
    expect(planArea.textContent).toContain('Копия создана: 25.09.2026');
    expect(planArea.textContent).toContain('Версия схемы данных копии: 4');
    // Предупреждения §7 071: замена — всегда, старее — при schemaDelta=older.
    expect(screen.getByTestId('data-restore-warning-replace').textContent).toContain(
      'будут полностью заменены',
    );
    expect(screen.getByTestId('data-restore-warning-older').textContent).toContain('старее');
  });

  it('неверный пароль → инлайн-ошибка, флоу не падает: шаг пароля доступен повторно (AC3)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'file/open-dialog') {
        return Promise.resolve({ v: 1, ok: true, data: { path: 'C:\\copies\\x.hlbackup' } });
      }
      return Promise.resolve({
        v: 1,
        ok: false,
        error: { code: 'BACKUP/WRONG_PASSPHRASE', messageKey: 'errors.BACKUP_WRONG_PASSPHRASE' },
      });
    });
    renderFlow();
    fireEvent.click(screen.getByTestId('data-restore-pick'));
    await waitFor(() => expect(screen.getByTestId('data-restore-passphrase')).toBeDefined());
    fireEvent.change(screen.getByTestId('data-restore-passphrase'), {
      target: { value: 'не-тот' },
    });
    fireEvent.click(screen.getByTestId('data-restore-next'));

    await waitFor(() =>
      expect(screen.getByTestId('data-restore-error').textContent).toBe(
        'Неверный пароль копии или файл повреждён.',
      ),
    );
    // Флоу жив: можно исправить пароль и повторить.
    expect(screen.getByTestId('data-restore-passphrase')).toBeDefined();
    expect(screen.queryByTestId('data-restore-plan')).toBeNull();
  });

  it('копия новее (BACKUP/DB_NEWER) → инлайн-ошибка с версией из params (§16-17 071)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'file/open-dialog') {
        return Promise.resolve({ v: 1, ok: true, data: { path: 'C:\\copies\\x.hlbackup' } });
      }
      return Promise.resolve({
        v: 1,
        ok: false,
        error: {
          code: 'BACKUP/DB_NEWER',
          messageKey: 'errors.BACKUP_DB_NEWER',
          params: { schemaVersion: 5 },
        },
      });
    });
    renderFlow();
    fireEvent.click(screen.getByTestId('data-restore-pick'));
    await waitFor(() => expect(screen.getByTestId('data-restore-passphrase')).toBeDefined());
    fireEvent.change(screen.getByTestId('data-restore-passphrase'), {
      target: { value: 'пароль' },
    });
    fireEvent.click(screen.getByTestId('data-restore-next'));

    await waitFor(() =>
      expect(screen.getByTestId('data-restore-error').textContent).toContain(
        'более новой версии схемы данных (v5)',
      ),
    );
  });
});

describe('RestoreFlow — шаг 3: чекбокс-гейт и execute (§13/§16)', () => {
  it('без чекбокса кнопка «Восстановить» недоступна; после отметки — активна (§13)', async () => {
    await renderAtPlan(PLAN);

    const execute = screen.getByTestId('data-restore-execute') as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('data-restore-confirm'));
    expect(execute.disabled).toBe(false);
    // Enter-спам по мёртвой кнопке канала не вызывает.
    fireEvent.keyDown(screen.getByTestId('data-restore-plan'), { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalledWith('backup/restore', expect.objectContaining({ confirmed: true }));
  });

  it('execute → backup/restore {confirmed:true} → рестарт-экран role=alert, диалог закрыт (AC2)', async () => {
    await renderAtPlan(PLAN);
    invoke.mockResolvedValue({ v: 1, ok: true, data: { restarting: true } });
    fireEvent.click(screen.getByTestId('data-restore-confirm'));

    fireEvent.click(screen.getByTestId('data-restore-execute'));

    const overlay = await waitFor(() => screen.getByTestId('data-restart-overlay'));
    expect(overlay.getAttribute('role')).toBe('alert');
    expect(overlay.textContent).toContain('Приложение перезапустится');
    expect(invoke).toHaveBeenCalledWith('backup/restore', {
      file: 'C:\\copies\\x.hlbackup',
      passphrase: 'пароль-копии',
      confirmed: true,
    });
    expect(screen.queryByTestId('data-restore-dialog')).toBeNull();
  });
});

describe('RestoreFlow — навигация и доступность (§10/§16)', () => {
  it('«Назад» до execute: план → пароль → файл (§10)', async () => {
    await renderAtPlan(PLAN);

    fireEvent.click(screen.getByTestId('data-restore-back'));
    expect(screen.getByTestId('data-restore-passphrase')).toBeDefined();
    fireEvent.click(screen.getByTestId('data-restore-back'));
    expect(screen.getByTestId('data-restore-pick')).toBeDefined();
  });

  it('Esc = безопасное действие: onClose (§16)', async () => {
    const onClose = vi.fn();
    renderFlow(true, onClose);
    await waitFor(() => expect(screen.getByTestId('data-restore-dialog')).toBeDefined());

    fireEvent.keyDown(screen.getByTestId('data-restore-dialog'), { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('axe — violations с impact=critical отсутствуют (шаг файла, §20)', async () => {
    renderFlow();
    const dialog = (await waitFor(() =>
      document.querySelector('[data-testid="data-restore-dialog"]'),
    )) as HTMLElement;

    // Axe по поддереву Content (портал Radix живёт в body — мимо фокус-гардов).
    const results = await axe.run(dialog);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});
