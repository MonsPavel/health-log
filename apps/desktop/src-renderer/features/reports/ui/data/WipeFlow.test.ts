/**
 * TASK-073 §5/§13/§19/§20 + §10 072: тесты флоу полного удаления (WipeFlow).
 * Матрица: открытие → data/wipe {phase:'plan'} (loading-статус до ответа); план
 * рендерится: счётчик измерений, категории (включая копии — §5), пункт про
 * localStorage (§10 072); ссылка-кнопка «Сначала экспортировать» вызывает
 * report/export-json (065) — успех/отказ инлайном; чекбокс-гейт execute (§13);
 * execute → {restarting:true} → рестарт-экран + очистка localStorage hl.* (§10 072,
 * прецедент wipe-local-storage); ошибка плана/execute — инлайн, диалог жив; Esc —
 * безопасное действие; axe — без critical.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope, DataWipePlan } from '@hl/contracts';

import '../../../../i18n';
import { PROFILE_ID } from '../../../measurement/api/use-add-measurement';
import { WipeFlow } from './WipeFlow';

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
  window.localStorage.clear();
});

function renderFlow(open = true, onClose: () => void = () => undefined): void {
  const client = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WipeFlow, { open, onClose }) as ReactElement,
    ) as ReactNode,
  );
}

const PLAN: DataWipePlan = {
  files: [
    { path: 'copy.hlbackup', category: 'backups' },
    { path: 'vault.key', category: 'key' },
    { path: 'health-log.db', category: 'db' },
  ],
  counts: { measurements: 350 },
  rendererLocalStorage: true,
};

/** Открыть флоу и дождаться плана. */
async function renderAtPlan(plan: DataWipePlan = PLAN): Promise<void> {
  invoke.mockResolvedValue({ v: 1, ok: true, data: { plan } });
  renderFlow();
  await waitFor(() => expect(screen.getByTestId('data-wipe-plan')).toBeDefined());
}

describe('WipeFlow — план (§5: предупреждение-список, включая копии)', () => {
  it('открытие → data/wipe {phase:plan}; до ответа — статус «Составляем список…»', async () => {
    let release!: (envelope: ApiEnvelope<unknown>) => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderFlow();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('data/wipe', { phase: 'plan' }));
    expect(screen.getByTestId('data-wipe-loading').textContent).toContain('Составляем список');

    release({ v: 1, ok: true, data: { plan: PLAN } });
    await waitFor(() => expect(screen.getByTestId('data-wipe-plan')).toBeDefined());
  });

  it('план: счётчик измерений, категории (БД/ключ/копии), пункт localStorage (§10 072)', async () => {
    await renderAtPlan();

    const planArea = screen.getByTestId('data-wipe-plan');
    expect(planArea.textContent).toContain('Измерений к удалению: 350');
    const categories = screen.getByTestId('data-wipe-categories');
    expect(categories.textContent).toContain('База данных измерений');
    expect(categories.textContent).toContain('Ключ шифрования');
    expect(categories.textContent).toContain('Локальные копии');
    expect(planArea.textContent).toContain('Черновики и локальные настройки');
  });
});

describe('WipeFlow — предложение экспорта (§5: «Сначала экспортировать» → 065)', () => {
  it('клик → report/export-json {profileId}; успех → инлайн с basename', async () => {
    await renderAtPlan();
    invoke.mockResolvedValue({
      v: 1,
      ok: true,
      data: { path: 'C:\\out\\health-log-export-20260925-1600.json' },
    });

    fireEvent.click(screen.getByTestId('data-wipe-export'));

    await waitFor(() => expect(screen.getByTestId('data-wipe-export-notice')).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('report/export-json', { profileId: PROFILE_ID });
    expect(screen.getByTestId('data-wipe-export-notice').textContent).toContain(
      'Экспорт сохранён: health-log-export-20260925-1600.json',
    );
  });

  it('экспорт не удался → инлайн-ошибка, диалог открыт (§10: контекст важен)', async () => {
    await renderAtPlan();
    invoke.mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: 'EXPORT/FAILED', messageKey: 'errors.EXPORT_FAILED' },
    });

    fireEvent.click(screen.getByTestId('data-wipe-export'));

    await waitFor(() =>
      expect(screen.getByTestId('data-wipe-export-notice').textContent).toContain(
        'Экспорт не удался.',
      ),
    );
    expect(screen.queryByTestId('data-wipe-dialog')).not.toBeNull();
  });
});

describe('WipeFlow — чекбокс-гейт и execute (§13/§10 072)', () => {
  it('без чекбокса кнопка «Удалить всё» недоступна; после отметки — активна (§13)', async () => {
    await renderAtPlan();

    const execute = screen.getByTestId('data-wipe-execute') as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('data-wipe-confirm'));
    expect(execute.disabled).toBe(false);
    // Enter-спам по мёртвой кнопке канала не вызывает.
    fireEvent.keyDown(screen.getByTestId('data-wipe-plan'), { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalledWith('data/wipe', { phase: 'execute' });
  });

  it('execute → data/wipe {phase:execute}; localStorage hl.* очищен; рестарт-экран (§10 072)', async () => {
    await renderAtPlan();
    window.localStorage.setItem('hl.formDraft', 'черновик');
    window.localStorage.setItem('other-key', 'чужой ключ остаётся');
    invoke.mockResolvedValue({ v: 1, ok: true, data: { restarting: true } });
    fireEvent.click(screen.getByTestId('data-wipe-confirm'));

    fireEvent.click(screen.getByTestId('data-wipe-execute'));

    const overlay = await waitFor(() => screen.getByTestId('data-restart-overlay'));
    expect(overlay.getAttribute('role')).toBe('alert');
    expect(overlay.textContent).toContain('перезапустится');
    expect(invoke).toHaveBeenCalledWith('data/wipe', { phase: 'execute' });
    // §10 072: hl.* стёрты, чужие ключи не тронуты.
    expect(window.localStorage.getItem('hl.formDraft')).toBeNull();
    expect(window.localStorage.getItem('other-key')).toBe('чужой ключ остаётся');
    expect(screen.queryByTestId('data-wipe-dialog')).toBeNull();
  });

  it('ошибка execute → инлайн в диалоге, рестарт-экран НЕ показан', async () => {
    await renderAtPlan();
    invoke.mockResolvedValue({
      v: 1,
      ok: false,
      error: {
        code: 'WIPE/FAILED',
        messageKey: 'errors.WIPE_FAILED',
        params: { remainingCount: 2 },
      },
    });
    fireEvent.click(screen.getByTestId('data-wipe-confirm'));

    fireEvent.click(screen.getByTestId('data-wipe-execute'));

    await waitFor(() =>
      expect(screen.getByTestId('data-wipe-error').textContent).toContain(
        'Не удалось полностью удалить данные',
      ),
    );
    expect(screen.queryByTestId('data-restart-overlay')).toBeNull();
    expect(screen.queryByTestId('data-wipe-dialog')).not.toBeNull();
  });
});

describe('WipeFlow — ошибка плана и доступность (§10/§16)', () => {
  it('ошибка плана → инлайн-ошибка в диалоге (§10: не тост)', async () => {
    invoke.mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: 'WIPE/FAILED', messageKey: 'errors.WIPE_FAILED' },
    });
    renderFlow();

    await waitFor(() =>
      expect(screen.getByTestId('data-wipe-error').textContent).toContain(
        'Не удалось полностью удалить данные',
      ),
    );
    expect(screen.queryByTestId('data-wipe-plan')).toBeNull();
  });

  it('Esc = безопасное действие: onClose (§16)', async () => {
    const onClose = vi.fn();
    renderFlow(true, onClose);
    await waitFor(() => expect(screen.getByTestId('data-wipe-dialog')).toBeDefined());

    fireEvent.keyDown(screen.getByTestId('data-wipe-dialog'), { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('axe — violations с impact=critical отсутствуют (шаг плана, §20)', async () => {
    await renderAtPlan();
    const dialog = document.querySelector('[data-testid="data-wipe-dialog"]') as HTMLElement;

    // Axe по поддереву Content (портал Radix живёт в body — мимо фокус-гардов).
    const results = await axe.run(dialog);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});
