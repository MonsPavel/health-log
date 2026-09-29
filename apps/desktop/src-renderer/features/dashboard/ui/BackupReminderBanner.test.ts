/**
 * TASK-074 §10/§16/§17/§19: тесты баннера-подсказки о копии (BackupReminderBanner).
 *
 * Матрица:
 *  - golden-текст (§17/§20): тон без упрёков — в текстах баннера НЕТ слов
 *    «забыли»/«забыли»-форм и «не делали» (запрет-слова в тесте); заголовок/текст
 *    — из каталога dashboard.banner.backup.*;
 *  - доступность (§16): роль status (не модальный, фокус не перехватывает),
 *    кнопки стандартные;
 *  - кнопки (§10): «Создать копию» → onCreate; «Позже» → onLater (скрытие —
 *    решение владельца SummaryScreen).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { BackupReminderBanner } from './BackupReminderBanner';

afterEach(() => {
  cleanup();
});

function renderBanner(onCreate: () => void = () => undefined, onLater: () => void = () => undefined): void {
  render(createElement(BackupReminderBanner, { onCreate, onLater }));
}

describe('BackupReminderBanner — текст и тон (§17/§20 golden)', () => {
  it('заголовок, текст и подписи кнопок — мягкий тон, без запрет-слов', () => {
    renderBanner();

    const title = screen.getByTestId('backup-reminder-title').textContent ?? '';
    const body = screen.getByTestId('backup-reminder-body').textContent ?? '';
    const create = screen.getByTestId('backup-reminder-create').textContent ?? '';
    const later = screen.getByTestId('backup-reminder-later').textContent ?? '';
    const all = `${title} ${body} ${create} ${later}`;

    expect(title).toBe('Пора сделать резервную копию дневника');
    expect(body).toContain('2 минут');
    expect(create).toBe('Создать копию');
    expect(later).toBe('Позже');

    // Golden-тест тона (§17): никаких упрёков — только забота.
    for (const forbidden of ['забыли', 'Забыли', 'не делали', 'Не делали', 'рискуете', 'потеряете']) {
      expect(all.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('текст не пугает: причина мягкая («если с устройством что-то случится»), не «данные сгорят»', () => {
    renderBanner();

    const body = screen.getByTestId('backup-reminder-body').textContent ?? '';
    expect(body).toMatch(/копия убережёт/);
    expect(body.toLowerCase()).not.toContain('сгорит');
    expect(body.toLowerCase()).not.toContain('утерян');
  });
});

describe('BackupReminderBanner — доступность (§16)', () => {
  it('баннер — role="status" (не модальный: фокус не перехватывает)', () => {
    renderBanner();

    const banner = screen.getByTestId('backup-reminder-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-modal')).toBeNull();
  });

  it('кнопки — стандартные button type=button (§16)', () => {
    renderBanner();

    expect(screen.getByTestId('backup-reminder-create').getAttribute('type')).toBe('button');
    expect(screen.getByTestId('backup-reminder-later').getAttribute('type')).toBe('button');
  });
});

describe('BackupReminderBanner — кнопки (§10/§19)', () => {
  it('«Создать копию» → onCreate (владелец открывает диалог 073)', () => {
    const onCreate = vi.fn();
    renderBanner(onCreate);

    fireEvent.click(screen.getByTestId('backup-reminder-create'));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('«Позже» → onLater (владелец скрывает до следующего показа)', () => {
    const onLater = vi.fn();
    renderBanner(() => undefined, onLater);

    fireEvent.click(screen.getByTestId('backup-reminder-later'));

    expect(onLater).toHaveBeenCalledTimes(1);
  });
});
