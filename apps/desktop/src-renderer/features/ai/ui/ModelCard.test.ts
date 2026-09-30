/**
 * TASK-081 §19/§20: компонентные тесты карточки модели — таблица ВСЕХ 6 состояний
 * машины 080 (AC1), предупреждения язык/RAM по фикстурам — не блокируют (AC4),
 * прогресс-бар с aria-valuenow (§16), aria-label кнопок состояний полные (§16),
 * тексты ошибок — по errorKey каталога errors (§17), колбэки кнопок.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelView } from '@hl/contracts';

import '../../../i18n';
import { ModelCard } from './ModelCard';

/** Базовый дескриптор (2 ГБ, ru+en, 16 ГБ ОЗУ). */
const DESCRIPTOR = {
  id: 'dev-ru',
  name: 'Dev Model',
  version: '1.0.0',
  file: 'dev.gguf',
  url: 'https://cdn.example.invalid/models/dev.gguf',
  sha256: 'a'.repeat(64),
  sizeBytes: 2_147_483_648,
  languages: ['ru', 'en'],
  minRamGb: 16,
  license: 'Apache-2.0',
} as const;

function view(overrides: Partial<ModelView> = {}): ModelView {
  return { descriptor: DESCRIPTOR, state: 'not_installed', ...overrides };
}

interface Handlers {
  onDownload: ReturnType<typeof vi.fn>;
  onPause: ReturnType<typeof vi.fn>;
  onResume: ReturnType<typeof vi.fn>;
  onReset: ReturnType<typeof vi.fn>;
  onSelect: ReturnType<typeof vi.fn>;
}

function renderCard(
  modelView: ModelView,
  overrides: { ramTotalGb?: number; uiLanguage?: string; selected?: boolean; busy?: boolean } = {},
): Handlers {
  const handlers: Handlers = {
    onDownload: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onReset: vi.fn(),
    onSelect: vi.fn(),
  };
  render(
    createElement(ModelCard, {
      view: modelView,
      ramTotalGb: overrides.ramTotalGb ?? 32,
      uiLanguage: overrides.uiLanguage ?? 'ru',
      selected: overrides.selected ?? false,
      busy: overrides.busy ?? false,
      onDownload: handlers.onDownload,
      onPause: handlers.onPause,
      onResume: handlers.onResume,
      onReset: handlers.onReset,
      onSelect: handlers.onSelect,
    }),
  );
  return handlers;
}

afterEach(() => {
  cleanup();
});

describe('ModelCard — 6 состояний машины 080 (TASK-081 §20 AC1, тест-таблица)', () => {
  it('not_installed: кнопка «Скачать», прогресса нет', () => {
    renderCard(view({ state: 'not_installed' }));

    expect(screen.getByTestId('model-download').textContent).toBe('Скачать');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('model-select')).toBeNull();
  });

  it('downloading: «Пауза» + прогрессбар aria-valuenow=10 + «10%» и «205 МБ из 2 ГБ»', () => {
    renderCard(view({ state: 'downloading', bytesLoaded: 214_748_365 }));

    expect(screen.getByTestId('model-pause').textContent).toBe('Пауза');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(screen.getByTestId('model-progress-percent').textContent).toBe('10%');
    expect(screen.getByTestId('model-progress-bytes').textContent).toBe('205 МБ из 2 ГБ');
  });

  it('paused: «Продолжить» + «Выбрать» + note-предложение продолжить (§13)', () => {
    renderCard(view({ state: 'paused', bytesLoaded: 1_073_741_824 }));

    expect(screen.getByTestId('model-resume').textContent).toBe('Продолжить');
    expect(screen.getByTestId('model-select')).toBeDefined();
    const note = screen.getByTestId('model-paused-note');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('приостановлена');
  });

  it('verifying: «Проверка файла…» отключена, прогрессбар 100%', () => {
    renderCard(view({ state: 'verifying', bytesLoaded: DESCRIPTOR.sizeBytes }));

    const checking = screen.getByTestId('model-checking');
    expect(checking.textContent).toBe('Проверка файла…');
    expect(checking.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('installed: «Выбрать»; при selected — бейдж «Выбрана» вместо кнопки (§5)', () => {
    const rerun = (selected: boolean): void => {
      cleanup();
      renderCard(view({ state: 'installed' }), { selected });
    };

    rerun(false);
    expect(screen.getByTestId('model-select').textContent).toBe('Выбрать');
    expect(screen.queryByTestId('model-selected-badge')).toBeNull();

    rerun(true);
    expect(screen.queryByTestId('model-select')).toBeNull();
    expect(screen.getByTestId('model-selected-badge').textContent).toBe('Выбрана');
  });

  it('error: текст по errorKey каталога errors + «Сбросить ошибку»', () => {
    renderCard(view({ state: 'error', errorKey: 'errors.AI_HASH_MISMATCH' }));

    const error = screen.getByTestId('model-error');
    expect(error.textContent).toContain('повреждён');
    expect(screen.getByTestId('model-reset').textContent).toBe('Сбросить ошибку');
  });
});

describe('ModelCard — предупреждения объясняющие, не блокируют (§20 AC4, §10)', () => {
  it('язык модели ≠ язык UI: note-предупреждение, кнопки состояний на месте', () => {
    renderCard(view(), { uiLanguage: 'ru' });
    const enView = view({
      descriptor: { ...DESCRIPTOR, languages: ['en'] },
      state: 'installed',
    });
    cleanup();
    renderCard(enView, { uiLanguage: 'ru' });

    const warn = screen.getByTestId('model-warn-language');
    expect(warn.getAttribute('role')).toBe('note');
    expect(warn.textContent).toContain('en');
    expect(warn.textContent).toContain('ru');
    // Не блокирует: «Выбрать» доступна (§5: предупреждение — не запрет).
    expect(screen.getByTestId('model-select')).toBeDefined();
  });

  it('RAM машины < minRamGb: note-предупреждение «может работать медленно»', () => {
    cleanup();
    renderCard(view(), { ramTotalGb: 8 });

    const warn = screen.getByTestId('model-warn-ram');
    expect(warn.getAttribute('role')).toBe('note');
    expect(warn.textContent).toContain('8');
    expect(warn.textContent).toContain('16');
    expect(warn.textContent).toContain('медленно');
  });

  it('совпадение языка и достаточная RAM — предупреждений нет', () => {
    renderCard(view(), { ramTotalGb: 32, uiLanguage: 'ru' });

    expect(screen.queryByTestId('model-warn-language')).toBeNull();
    expect(screen.queryByTestId('model-warn-ram')).toBeNull();
  });
});

describe('ModelCard — aria-label кнопок полные (§16) и колбэки', () => {
  it('aria-label скачивания/паузы/выбора содержат имя и процент; клики зовут колбэки', () => {
    const pauseCard = renderCard(view({ state: 'downloading', bytesLoaded: 214_748_365 }));

    expect(screen.getByTestId('model-pause').getAttribute('aria-label')).toBe(
      'Приостановить загрузку модели «Dev Model», загружено 10%',
    );
    fireEvent.click(screen.getByTestId('model-pause'));
    expect(pauseCard.onPause).toHaveBeenCalledTimes(1);

    cleanup();
    const selectCard = renderCard(view({ state: 'installed' }), { selected: false });
    expect(screen.getByTestId('model-select').getAttribute('aria-label')).toBe(
      'Выбрать модель «Dev Model»',
    );
    fireEvent.click(screen.getByTestId('model-select'));
    expect(selectCard.onSelect).toHaveBeenCalledTimes(1);

    cleanup();
    const downloadCard = renderCard(view({ state: 'not_installed' }));
    expect(screen.getByTestId('model-download').getAttribute('aria-label')).toBe(
      'Скачать модель «Dev Model» (2 ГБ)',
    );
    fireEvent.click(screen.getByTestId('model-download'));
    expect(downloadCard.onDownload).toHaveBeenCalledTimes(1);
  });

  it('busy (мутация в полёте) — кнопки состояния отключены', () => {
    renderCard(view({ state: 'not_installed' }), { busy: true });

    expect(screen.getByTestId('model-download').hasAttribute('disabled')).toBe(true);
  });
});
