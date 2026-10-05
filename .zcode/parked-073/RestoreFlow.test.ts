/**
 * TASK-073 §5/§9/§10/§13/§19: тесты мастер-флоу восстановления (RestoreFlow):
 * шаги файл → пароль → план → execute; рестарт-экран отдаётся владельцу (§10:
 * блокирующий — рендерит DataSection). Матрица:
 *  - шаг 1: «Выбрать файл копии…» → канал file/open-dialog с фильтром hlbackup (§9);
 *  - отмена пикера ({canceled:true}) → остаёмся на шаге файла, без ошибки (§7);
 *  - после выбора файла → шаг пароля, basename файла показан;
 *  - план: предупреждения рендерятся (замена/старее), counts copy/current, дата;
 *  - чекбокс-гейт: execute недоступен без чекбокса, доступен после (§13 — тест);
 *  - execute → backup/restore {confirmed:true} → {restarting:true} → onRestarting (§9);
 *  - неверный пароль → инлайн-ошибка, флоу жив (AC);
 *  - DB_NEWER → инлайн-ошибка с schemaVersion (EC-25);
 *  - «Назад» до execute — на шаг пароля и файла (§10);
 *  - «Отмена» → onClose (safe-action).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope } from '@hl/contracts';

import { RestoreFlow, type RestoreFlowProps } from './RestoreFlow';

import '../../../../i18n';

type InvokeMock = ReturnType<typeof vi.fn<(channel: string, payload: unknown) => Promise<ApiEnvelope<unknown>>>>;

const invoke: InvokeMock = vi.fn();

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

function renderFlow(props: Partial<RestoreFlowProps> = {}): {
  onClose: ReturnType<typeof vi.fn>;
  onRestarting: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onRestarting = vi.fn();
  const client = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RestoreFlow, { open: true, onClose, onRestarting, ...props }) as ReactElement,
    ) as ReactNode,
  );
  return { onClose, onRestarting };
}

const pickFile = (): HTMLElement => screen.getByRole('button', { name: 'Выбрать файл копии…' });
const passphraseInput = (): HTMLInputElement =>
  screen.getByLabelText('Пароль копии') as HTMLInputElement;

/** Кладёт файл в шаг пароля (шаг 1 пройден). */
async function goToPassphraseStep(): Promise<void> {
  invoke.mockResolvedValueOnce({ v: 1, ok: true, data: { path: 'C:\\tmp\\моя-копия.hlbackup' } });
  fireEvent.click(pickFile());
  await waitFor(() => expect(passphraseInput()).toBeDefined());
}

/** Кладёт план в шаг плана (шаги 1–2 пройдены). */
async function goToPlanStep(): Promise<void> {
  await goToPassphraseStep();
  invoke.mockResolvedValueOnce({
    v: 1,
    ok: true,
    data: {
      plan: {
        schemaVersion: 2,
        schemaDelta: 'equal',
        createdAtUtc: 1_758_816_000_000,
        counts: { measurements: 120 },
        currentCounts: { measurements: 350 },
        warnings: ['replaces-current'],
      },
    },
  });
  fireEvent.change(passphraseInput(), { target: { value: 'пароль-копии' } });
  fireEvent.click(screen.getByRole('button', { name: 'Показать план восстановления' }));
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined());
}

describe('RestoreFlow — мастер-флоу восстановления (TASK-073 §19/§10)', () => {
  it('шаг 1: «Выбрать файл копии…» → канал file/open-dialog с фильтром hlbackup (§9)', async () => {
    invoke.mockResolvedValueOnce({ v: 1, ok: true, data: { canceled: true } });
    renderFlow();

    fireEvent.click(pickFile());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('file/open-dialog', {
        filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
      }),
    );
  });

  it('отмена пикера {canceled:true} → остаёмся на шаге файла без ошибки (§7)', async () => {
    invoke.mockResolvedValueOnce({ v: 1, ok: true, data: { canceled: true } });
    renderFlow();

    fireEvent.click(pickFile());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    expect(screen.getByText('Шаг 1 из 3 — выберите файл копии')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('после выбора файла → шаг пароля, basename файла показан', async () => {
    renderFlow();

    await goToPassphraseStep();

    expect(screen.getByText('Шаг 2 из 3 — введите пароль копии')).toBeDefined();
    expect(screen.getByText('Выбран файл: моя-копия.hlbackup')).toBeDefined();
  });

  it('план: предупреждение замены + counts copy/current; «старее» — при schemaDelta older (§5/§13)', async () => {
    renderFlow();

    await goToPlanStep();
    // Вернёмся и возьмём план с older-предупреждением (повторный прогон шагов).
    cleanup();
    renderFlow();
    await goToPassphraseStep();
    invoke.mockResolvedValueOnce({
      v: 1,
      ok: true,
      data: {
        plan: {
          schemaVersion: 1,
          schemaDelta: 'older',
          createdAtUtc: 1_758_816_000_000,
          counts: { measurements: 120 },
          currentCounts: { measurements: 350 },
          warnings: ['replaces-current', 'older-than-current'],
        },
      },
    });
    fireEvent.change(passphraseInput(), { target: { value: 'пароль-копии' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать план восстановления' }));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined());

    const text = document.body.textContent ?? '';
    expect(text).toContain('Текущие данные будут полностью заменены данными из копии.');
    expect(text).toContain(
      'Копия старее текущей схемы данных — после перезапуска применятся миграции.',
    );
    expect(text).toContain('В копии: 120 записей; сейчас в журнале: 350.');
    expect(text).toContain('Копия создана:'); // дата плана (формат Intl, подстрока префикса)
  });

  it('чекбокс-гейт: execute недоступен без чекбокса, доступен после (§13 — тест защиты от Enter-спама)', async () => {
    renderFlow();

    await goToPlanStep();
    const execute = screen.getByRole('button', { name: 'Восстановить и перезапустить' });
    expect(execute.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(execute.hasAttribute('disabled')).toBe(false);
  });

  it('execute → backup/restore {confirmed:true} → {restarting:true} → onRestarting (§9)', async () => {
    const { onRestarting } = renderFlow();

    await goToPlanStep();
    invoke.mockResolvedValueOnce({ v: 1, ok: true, data: { restarting: true } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить и перезапустить' }));

    await waitFor(() => expect(onRestarting).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('backup/restore', {
      file: 'C:\\tmp\\моя-копия.hlbackup',
      passphrase: 'пароль-копии',
      confirmed: true,
    });
  });

  it('неверный пароль → инлайн-ошибка WRONG_PASSPHRASE, флоу не падает, можно повторить (AC)', async () => {
    renderFlow();

    await goToPassphraseStep();
    invoke.mockResolvedValueOnce({
      v: 1,
      ok: false,
      error: { code: 'BACKUP/WRONG_PASSPHRASE', messageKey: 'errors.BACKUP_WRONG_PASSPHRASE' },
    });
    fireEvent.change(passphraseInput(), { target: { value: 'неверный' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать план восстановления' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('Неверный пароль копии или файл повреждён.');
    // Флоу жив: шаг пароля доступен для повтора.
    expect(screen.getByRole('button', { name: 'Показать план восстановления' }).hasAttribute('disabled')).toBe(false);
  });

  it('BACKUP/DB_NEWER → инлайн-ошибка с подстановкой schemaVersion (EC-25)', async () => {
    renderFlow();

    await goToPassphraseStep();
    invoke.mockResolvedValueOnce({
      v: 1,
      ok: false,
      error: {
        code: 'BACKUP/DB_NEWER',
        messageKey: 'errors.BACKUP_DB_NEWER',
        params: { schemaVersion: 3 },
      },
    });
    fireEvent.change(passphraseInput(), { target: { value: 'пароль' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать план восстановления' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('схема v3');
  });

  it('«Назад» до execute: план → шаг пароля (§10)', async () => {
    renderFlow();

    await goToPlanStep();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));

    expect(screen.getByText('Шаг 2 из 3 — введите пароль копии')).toBeDefined();
  });

  it('«Отмена» закрывает флоу (safe-action, §16)', () => {
    const { onClose } = renderFlow();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
