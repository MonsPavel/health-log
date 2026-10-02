/**
 * TASK-103 §19/§20: DOM-тесты секции «Диагностика» (мок каналов diag/*):
 *  - AC §20-3: клик «Собрать пакет» → invoke diag/preview → дерево файлов с
 *    размерами и превью первых строк отображается ДО сохранения; diag/save при
 *    этом НЕ вызван (предпросмотр обязателен, §14);
 *  - AC §20-6: golden-предупреждение «в пакет не входят ваши измерения и заметки»
 *    присутствует (гарантия — до и после сбора);
 *  - «Сохранить…» — invoke diag/save {} (путь выбирает main-диалог, §14); ответ
 *    {path} → статус сохранён; {canceled: true} — тихо, ошибки нет (§7 065);
 *  - счётчик записей (totals.eventsByKind) отображается;
 *  - размеры — Intl (§17): байты/КБ/МБ ru-формат.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiagContent } from '@hl/contracts';

import '../../../i18n';
import { DiagSection } from './DiagSection';

type InvokeMock = ReturnType<typeof vi.fn<(channel: string, payload: unknown) => Promise<unknown>>>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const CONTENT: DiagContent = {
  files: [
    {
      name: 'hl.1.log',
      sizeBytes: 2048,
      preview: '{"msg":"container ready"}\n{"msg":"self-check"}',
    },
    { name: 'versions.json', sizeBytes: 300, preview: '{\n  "appVersion": "1.2.3"\n}' },
    { name: 'big.log', sizeBytes: 5 * 1024 * 1024 }, // защитная ветка §9: без preview
  ],
  totals: { eventsByKind: { 'app.start': 3, 'ai.summary.generate': 1 } },
};

let invoke: InvokeMock;
let previewData: DiagContent | undefined;
let saveData: unknown;

beforeEach(() => {
  previewData = CONTENT;
  saveData = { path: 'D:\\diag\\health-log-diag.zip' };
});

afterEach(() => {
  cleanup();
});

/** Мост: diag/preview|diag/save (§19, прецедент UpdatesSection.test). */
function makeHl(): void {
  invoke = vi.fn((channel: string, payload: unknown) => {
    void payload; // payload ответа не влияет на фейк, но фиксируется в mock.calls
    if (channel === 'diag/preview') {
      return Promise.resolve(OK(previewData));
    }
    if (channel === 'diag/save') {
      return Promise.resolve(OK(saveData));
    }
    return Promise.resolve(OK(null));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn(() => () => undefined),
    },
  });
}

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(DiagSection), { wrapper });
}

/** Клик «Собрать пакет» с ожиданием активации кнопки (сборка — явное действие). */
async function clickCollect(): Promise<void> {
  const button = await screen.findByTestId('diag-collect');
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
}

describe('DiagSection — предпросмотр до сохранения (TASK-103 §5/§20)', () => {
  beforeEach(makeHl);

  it('AC §20-3: сборка → дерево файлов (имя, размер, превью) отображено ДО сохранения', async () => {
    renderSection();
    // До сбора предпросмотра нет, сохранения нет.
    expect(screen.queryByTestId('diag-preview')).toBeNull();

    await clickCollect();
    await waitFor(() => expect(screen.getByTestId('diag-preview')).toBeDefined());

    // Дерево файлов: имена всех трёх файлов, размеры в Intl-формате, превью строк.
    expect(screen.getByText('hl.1.log')).toBeDefined();
    expect(screen.getByText('versions.json')).toBeDefined();
    expect(screen.getByText('big.log')).toBeDefined();
    expect(screen.getAllByTestId('diag-file-size')).toHaveLength(3);
    expect(screen.getByText('2 КБ')).toBeDefined(); // §17: размеры — Intl (ru)
    expect(screen.getByText('5 МБ')).toBeDefined();
    expect(screen.getAllByTestId('diag-file-preview')).toHaveLength(2); // big.log без preview
    expect(screen.getAllByTestId('diag-file-preview')[0]?.textContent).toContain(
      '{"msg":"container ready"}',
    );

    // Предпросмотр обязателен (§14): сохранение ещё НЕ вызывалось.
    const saveCalls = invoke.mock.calls.filter(([channel]) => channel === 'diag/save');
    expect(saveCalls).toHaveLength(0);
  });

  it('AC §20-6: golden-предупреждение «в пакет не входят ваши измерения и заметки» присутствует', async () => {
    renderSection();
    // До сбора — гарантия видна (пользователь знает заранее, что собирается).
    expect(screen.getByTestId('diag-warning').textContent).toContain(
      'в пакет не входят ваши измерения и заметки',
    );
    await clickCollect();
    await waitFor(() => expect(screen.getByTestId('diag-preview')).toBeDefined());
    expect(screen.getByTestId('diag-warning').textContent).toContain(
      'в пакет не входят ваши измерения и заметки',
    );
  });

  it('счётчик записей (totals.eventsByKind) отображается в предпросмотре', async () => {
    renderSection();
    await clickCollect();
    await waitFor(() => expect(screen.getByTestId('diag-preview')).toBeDefined());
    const totals = screen.getByTestId('diag-totals');
    expect(totals.textContent).toContain('app.start');
    expect(totals.textContent).toContain('3');
    expect(totals.textContent).toContain('ai.summary.generate');
  });

  it('«Сохранить…» — invoke diag/save {}; {path} → статус сохранён', async () => {
    renderSection();
    await clickCollect();
    const save = await screen.findByTestId('diag-save');
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByTestId('diag-saved')).toBeDefined());
    const saveCalls = invoke.mock.calls.filter(([channel]) => channel === 'diag/save');
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.[1]).toEqual({});
  });

  it('отмена диалога ({canceled: true}) — тихо: ошибки нет, статуса сохранения нет (§7 065)', async () => {
    saveData = { canceled: true };
    renderSection();
    await clickCollect();
    const save = await screen.findByTestId('diag-save');
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    expect(screen.queryByTestId('diag-saved')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('отказ канала diag/preview — role="alert", секция не падает', async () => {
    invoke = vi.fn((channel: string, payload: unknown) => {
      void payload;
      if (channel === 'diag/preview') {
        return Promise.resolve({
          v: 1,
          ok: false,
          error: { code: 'APP/INTERNAL', messageKey: 'errors.internal' },
        });
      }
      return Promise.resolve(OK(null));
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    renderSection();
    await clickCollect();
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.queryByTestId('diag-preview')).toBeNull();
  });
});

describe('DiagSection — интервал 90 дней в подписи агрегатов (§5)', () => {
  beforeEach(makeHl);

  it('подпись блока агрегатов упоминает окно 90 дней', async () => {
    renderSection();
    await clickCollect();
    await waitFor(() => expect(screen.getByTestId('diag-totals')).toBeDefined());
    // Окно агрегатов фиксировано сборщиком main (90 дней) — текст отражает срок.
    expect(screen.getByTestId('diag-totals').textContent).toContain('90');
  });
});
