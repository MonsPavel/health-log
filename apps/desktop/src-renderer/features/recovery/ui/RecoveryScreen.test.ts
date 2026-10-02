/**
 * TASK-101 §5/§13/§16/§17/§19: DOM-тесты экрана восстановления (мок канала):
 *  - показ: заголовок + спокойное объяснение role=alert, восстановление — первичное
 *    действие, «начать заново» — за двойным подтверждением (§13/§22);
 *  - восстановление happy: файл-пикер → пароль → backup/restore {recovery: true} →
 *    заметка о перезапуске (§13);
 *  - неверный пароль → инлайн-retry (очистка поля, §13); копия новее → объяснение;
 *  - «начать заново»: чекбокс-гейт кнопки (§13 — защита от Enter-спама) → канал;
 *  - техдетали: раскрытие с quick_check (§16/§20 AC4), обе причины (§20 AC5-стиль);
 *  - golden-тон каталога: запрет паник-лексики (§17/§20 AC6).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import recoveryCatalog from '../../../i18n/ru/recovery.json';
import { RecoveryScreen } from './RecoveryScreen';

import '../../../i18n';

type InvokeMock = ReturnType<typeof vi.fn>;

let invoke: InvokeMock;

const OK = (data: unknown) => ({ v: 1, ok: true, data });
const FAIL = (code: string, messageKey: string) => ({
  v: 1,
  ok: false,
  error: { code, messageKey },
});

/** Мост: отвечающий по каналам (диалог, restore, discard, reveal). */
function mockHl(respond: (channel: string) => unknown): void {
  invoke = vi.fn((channel: string) => Promise.resolve(respond(channel)));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
}

const CORRUPT = {
  reason: 'corrupt',
  details: { quickCheck: '*** in database main - Page 7 is never used' },
} as const;

const MIGRATION_FAILED = {
  reason: 'migration_failed',
  details: { migrationVersion: 8 },
} as const;

function renderScreen(recovery: typeof CORRUPT | typeof MIGRATION_FAILED = CORRUPT): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(RecoveryScreen, { recovery }), { wrapper });
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('RecoveryScreen — показ (TASK-101 §5/§16)', () => {
  it('заголовок, спокойное объяснение role=alert, восстановление — первичное действие', () => {
    mockHl(() => OK(null));
    renderScreen();

    expect(screen.getByRole('heading', { name: 'Не удалось открыть дневник' })).toBeDefined();
    const explain = screen.getByTestId('recovery-explain');
    expect(explain.getAttribute('role')).toBe('alert');
    expect(explain.textContent).toContain('резервной копии');
    // §22: восстановление идёт ПЕРВЫМ, «начать заново» — за отдельным раскрытием.
    const restore = screen.getByTestId('recovery-restore-pick');
    const discard = screen.getByTestId('recovery-discard-open');
    expect(
      restore.compareDocumentPosition(discard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Форма восстановления скрыта до выбора файла; «начать заново» — до раскрытия.
    expect(screen.queryByTestId('recovery-restore-pass')).toBeNull();
    expect(screen.queryByTestId('recovery-discard-execute')).toBeNull();
  });

  it('техдетали: раскрытие показывает причину corrupt и вывод quick_check (§20 AC4)', () => {
    mockHl(() => OK(null));
    renderScreen();

    const details = screen.getByTestId('recovery-details');
    expect(details.hasAttribute('open')).toBe(false); // collapse — не пугать (§16)
    fireEvent.click(screen.getByText('Технические детали'));
    const text = screen.getByTestId('recovery-details-text');
    expect(text.textContent).toContain('повреждение файла базы данных');
    expect(text.textContent).toContain('*** in database main - Page 7 is never used');
  });

  it('техдетали: причина migration_failed с версией (§20 AC5-стиль)', () => {
    mockHl(() => OK(null));
    renderScreen(MIGRATION_FAILED);

    fireEvent.click(screen.getByText('Технические детали'));
    const text = screen.getByTestId('recovery-details-text');
    expect(text.textContent).toContain('провал обновления схемы');
    expect(text.textContent).toContain('8');
    expect(text.textContent).not.toContain('quick_check'); // вывода нет — строки нет
  });
});

describe('RecoveryScreen — восстановление из копии (TASK-101 §5/§13)', () => {
  it('happy: пикер → пароль → backup/restore {recovery: true, file, passphrase} → перезапуск', async () => {
    mockHl((channel) => {
      if (channel === 'file/open-dialog') {
        return OK({ path: 'D:\\backups\\copy.hlbackup' });
      }
      return OK({ restarting: true });
    });
    renderScreen();

    fireEvent.click(screen.getByTestId('recovery-restore-pick'));
    const picked = await screen.findByTestId('recovery-restore-picked');
    expect(picked.textContent).toContain('copy.hlbackup');

    const pass = screen.getByTestId('recovery-restore-pass');
    const submit = screen.getByTestId('recovery-restore-submit');
    expect(submit.hasAttribute('disabled')).toBe(true); // пустой пароль — не отправляется
    fireEvent.change(pass, { target: { value: 'пароль-копии' } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('backup/restore', {
        recovery: true,
        file: 'D:\\backups\\copy.hlbackup',
        passphrase: 'пароль-копии',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('recovery-restart-note')).toBeDefined());
    // После решения действия скрыты — экран спокойный до перезапуска (§16).
    expect(screen.queryByTestId('recovery-restore-pick')).toBeNull();
  });

  it('неверный пароль: инлайн-retry, поле очищено, канал с тем же файлом (§13)', async () => {
    mockHl((channel) => {
      if (channel === 'file/open-dialog') {
        return OK({ path: 'D:\\backups\\copy.hlbackup' });
      }
      return FAIL('BACKUP/WRONG_PASSPHRASE', 'errors.BACKUP_WRONG_PASSPHRASE');
    });
    renderScreen();

    fireEvent.click(screen.getByTestId('recovery-restore-pick'));
    await screen.findByTestId('recovery-restore-picked');
    fireEvent.change(screen.getByTestId('recovery-restore-pass'), {
      target: { value: 'неверный' },
    });
    fireEvent.click(screen.getByTestId('recovery-restore-submit'));

    const error = await screen.findByTestId('recovery-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('Неверный пароль копии');
    expect(screen.queryByTestId('recovery-restart-note')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('recovery-restore-pass').value).toBe('');
  });

  it('копия новее схемы: объяснение об обновлении приложения (§13 «та же защита 071»)', async () => {
    mockHl((channel) => {
      if (channel === 'file/open-dialog') {
        return OK({ path: 'D:\\backups\\new.hlbackup' });
      }
      return FAIL('BACKUP/DB_NEWER', 'errors.BACKUP_DB_NEWER');
    });
    renderScreen();

    fireEvent.click(screen.getByTestId('recovery-restore-pick'));
    await screen.findByTestId('recovery-restore-picked');
    fireEvent.change(screen.getByTestId('recovery-restore-pass'), {
      target: { value: 'пароль' },
    });
    fireEvent.click(screen.getByTestId('recovery-restore-submit'));

    const error = await screen.findByTestId('recovery-error');
    expect(error.textContent).toContain('более новой версией схемы');
    expect(screen.queryByTestId('recovery-restart-note')).toBeNull();
  });
});

describe('RecoveryScreen — начать заново (TASK-101 §5/§13)', () => {
  it('двойное подтверждение: раскрытие → чекбокс-гейт → data/discard-db → перезапуск', async () => {
    mockHl(() => OK({ restarting: true }));
    renderScreen();

    fireEvent.click(screen.getByTestId('recovery-discard-open'));
    const execute = screen.getByTestId('recovery-discard-execute');
    expect(execute.hasAttribute('disabled')).toBe(true); // чекбокс-гейт (§13)
    fireEvent.click(execute);
    expect(invoke).not.toHaveBeenCalledWith('data/discard-db', {});

    fireEvent.click(screen.getByTestId('recovery-discard-checkbox'));
    fireEvent.click(screen.getByTestId('recovery-discard-execute'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('data/discard-db', {}));
    await waitFor(() => expect(screen.getByTestId('recovery-restart-note')).toBeDefined());
  });
});

describe('RecoveryScreen — папка с копиями и golden-тон (TASK-101 §5/§17)', () => {
  it('«Открыть папку с копиями» вызывает app/reveal-backups (§9)', async () => {
    mockHl(() => OK(null));
    renderScreen();

    fireEvent.click(screen.getByTestId('recovery-reveal-backups'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app/reveal-backups', {}));
  });

  it('golden-тон каталога recovery: без паник-лексики (§17/§20 AC6)', () => {
    // Паник-корпус: CAPS-тревоги, восклицательные серии, «сломано навсегда».
    const panic = /(ОШИБКА|ФАТАЛЬН|СБОЙ|КРАШ|КРИТИЧЕСК|!!!|УТЕРЯНЫ НАВСЕГДА|СЛОМАН)/i;
    const offenders = Object.values(recoveryCatalog).filter((text) => panic.test(text));
    expect(offenders).toEqual([]);
  });
});
