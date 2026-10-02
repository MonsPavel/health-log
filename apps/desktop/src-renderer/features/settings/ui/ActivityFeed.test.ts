/**
 * TASK-099 §19/§13/§16: DOM-тесты ленты сетевых активностей «Приватности»
 * (чистая презентация — DTO-фикстуры канала privacy/journal, §11 098):
 *  - статусы ok/blocked/failed (+running) различимы ТЕКСТОМ, глифом и цветом —
 *    не только цветом (§13 дальтонизм, §16); aria-метка статуса полная;
 *  - объём: bytes → КБ/МБ (Intl ru, §5); bytes отсутствует (blocked/failed без
 *    content-length) → «—» (§5 «bytes?»);
 *  - дата-время — Intl настенное до минут (прецедент UpdatesSection LastCheckRow);
 *  - empty-состояние: «Сетевых активностей не было» (§5 golden);
 *  - неизвестная операция ленты — честный raw-kind вместо выдуманного названия.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NetworkEventDto } from '@hl/contracts';

import { ActivityFeed } from './ActivityFeed';

const T = Date.UTC(2026, 0, 15, 9, 30);

const ENTRY_OK: NetworkEventDto = {
  kind: 'models.download',
  endpoint: 'https://cdn.example.com/m.bin',
  status: 'ok',
  bytes: 2048,
  atUtc: T,
};

const ENTRY_BLOCKED: NetworkEventDto = {
  kind: 'updates.check',
  endpoint: '',
  status: 'blocked',
  atUtc: T + 1,
};

const ENTRY_FAILED: NetworkEventDto = {
  kind: 'models.download',
  endpoint: 'https://cdn.example.com/m.bin',
  status: 'failed',
  bytes: 3_500_000,
  atUtc: T + 2,
};

const ENTRY_RUNNING: NetworkEventDto = {
  kind: 'models.download',
  endpoint: 'https://cdn.example.com/m.bin',
  status: 'running',
  atUtc: T + 3,
};

function renderFeed(entries: readonly NetworkEventDto[]): void {
  render(createElement(ActivityFeed, { entries }));
}

afterEach(() => {
  cleanup();
});

describe('ActivityFeed — статусы: текст + глиф + цвет (§13/§16/AC3)', () => {
  it('ok/blocked/failed: тексты различны, глифы различны, цвета различны', () => {
    renderFeed([ENTRY_OK, ENTRY_BLOCKED, ENTRY_FAILED]);

    const badges = screen.getAllByTestId('feed-status');
    expect(badges).toHaveLength(3);
    const texts = badges.map((b) => b.textContent ?? '');
    expect(texts).toContain('успешно');
    expect(texts).toContain('заблокировано');
    expect(texts).toContain('ошибка');
    // Не только цветом (§13): у каждого статуса свой глиф.
    const glyphs = badges.map((b) => b.textContent?.trim().charAt(0) ?? '');
    expect(new Set(glyphs).size).toBe(3);
    // Цвет — класс (ok зелёный, blocked серый/нейтральный, failed красный).
    const classes = badges.map((b) => b.className);
    expect(new Set(classes).size).toBe(3);
    expect(classes[0]).toContain('green');
    expect(classes[1]).not.toContain('green');
    expect(classes[1]).not.toContain('red');
    expect(classes[2]).toContain('red');
  });

  it('aria-метка статуса полная (§16) и различна у всех трёх статусов', () => {
    renderFeed([ENTRY_OK, ENTRY_BLOCKED, ENTRY_FAILED]);

    const labels = screen
      .getAllByTestId('feed-status')
      .map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels.every((label) => label.length > 8)).toBe(true);
    expect(new Set(labels).size).toBe(3);
  });

  it('running: нейтральный статус «выполняется» (домен 075 — жизненный цикл)', () => {
    renderFeed([ENTRY_RUNNING]);

    expect(screen.getByTestId('feed-status').textContent).toContain('выполняется');
  });
});

describe('ActivityFeed — объём и время (§5)', () => {
  it('bytes → КБ/МБ (Intl ru): 2048 → «2 КБ», 3 500 000 → «3,3 МБ»', () => {
    renderFeed([ENTRY_OK, ENTRY_FAILED]);

    const volumes = screen.getAllByTestId('feed-volume').map((el) => el.textContent ?? '');
    expect(volumes).toContain('2 КБ');
    expect(volumes).toContain('3,3 МБ');
  });

  it('bytes отсутствует → «—» (NULL журнала, §5 «bytes?»)', () => {
    renderFeed([ENTRY_BLOCKED]);

    expect(screen.getByTestId('feed-volume').textContent).toBe('—');
  });

  it('дата-время строки — Intl настенное до минут (прецедент LastCheckRow)', () => {
    renderFeed([ENTRY_OK]);

    expect(screen.getByTestId('feed-time').textContent).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  });
});

describe('ActivityFeed — empty и неизвестная операция (§5)', () => {
  it('пустая лента: «Сетевых активностей не было» (golden §5)', () => {
    renderFeed([]);

    expect(screen.getByTestId('feed-empty').textContent).toBe('Сетевых активностей не было');
    expect(screen.queryByTestId('feed-row')).toBeNull();
  });

  it('неизвестный kind — честный raw-kind (не выдуманное название)', () => {
    renderFeed([{ ...ENTRY_OK, kind: 'future.op' }]);

    expect(screen.getByTestId('feed-op').textContent).toBe('future.op');
  });
});
