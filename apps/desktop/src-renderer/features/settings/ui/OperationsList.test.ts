/**
 * TASK-099 §19/§5/§10/§13/§16: DOM-тесты списка операций «Приватности»
 * (презентационный — ops из канала privacy/journal, согласия — документ
 * privacy/consents, §12 098):
 *  - ops-список рендерится с названиями и описаниями «зачем» (каталог §17,
 *    белые словари §22 — прецедент ModelCard ERROR_TEXT_KEYS);
 *  - переключатель — switch-паттерн aria-checked (§16), значение из документа
 *    согласий (optimistic — мгновенно, §5/§10);
 *  - включение — сразу onToggle (§5 «мгновенное применение»);
 *  - отключение — за confirm-диалогом: «загрузка моделей станет недоступна»
 *    (golden §5); отмена — onToggle НЕ вызван (AC4-дефолт);
 *  - блокировка при загрузке модели (§13/§10): switch disabled + tooltip
 *    «идёт загрузка», чужие операции не затронуты;
 *  - неизвестная операция — raw-name, описания нет (честность, без выдумки).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Consents, OperationInfo } from '@hl/contracts';

import '../../../i18n';
import { OperationsList } from './OperationsList';

const OPS: OperationInfo[] = [
  {
    op: 'models.download',
    consentKey: 'modelsDownload',
    descriptionKey: 'privacy.ops.models_download',
    enabled: true,
  },
  {
    op: 'updates.check',
    consentKey: 'updatesCheck',
    descriptionKey: 'privacy.ops.updates_check',
    enabled: false,
  },
];

const CONSENTS: Consents = { updatesCheck: false, modelsDownload: true };

interface Props {
  readonly ops?: OperationInfo[];
  readonly consents?: Consents | undefined;
  readonly downloadInProgress?: boolean;
}

function renderList(props: Props = {}): ReturnType<typeof vi.fn> {
  const onToggle = vi.fn();
  render(
    createElement(OperationsList, {
      ops: props.ops ?? OPS,
      consents: props.consents === undefined ? CONSENTS : props.consents,
      downloadInProgress: props.downloadInProgress ?? false,
      onToggle,
    }),
  );
  return onToggle;
}

/** Согласие по названию операции (aria-labelledby — названия из каталога). */
function switchByName(name: string): HTMLElement {
  return screen.getByRole('switch', { name });
}

afterEach(() => {
  cleanup();
});

describe('OperationsList — ops из канала с описаниями (§19/§17)', () => {
  it('обе операции: названия и описания «зачем» из каталога (golden-тексты)', () => {
    renderList();

    expect(screen.getByRole('switch', { name: 'Загрузка моделей ИИ' })).toBeDefined();
    expect(screen.getByText('Скачивает файлы локальных ИИ-моделей с CDN по вашему запросу')).toBeDefined();
    expect(screen.getByRole('switch', { name: 'Проверка обновлений' })).toBeDefined();
    expect(screen.getByText('Спрашивает сервер обновлений о новой версии приложения')).toBeDefined();
  });

  it('aria-checked из документа согласий (optimistic-источник, §12)', () => {
    renderList({ consents: { updatesCheck: false, modelsDownload: true } });

    expect(switchByName('Загрузка моделей ИИ').getAttribute('aria-checked')).toBe('true');
    expect(switchByName('Проверка обновлений').getAttribute('aria-checked')).toBe('false');
  });
});

describe('OperationsList — переключение (§5/§13/AC2)', () => {
  it('включение: onToggle с patch сразу, без диалога (§5 «мгновенно»)', () => {
    const onToggle = renderList({ consents: { updatesCheck: false, modelsDownload: true } });

    fireEvent.click(switchByName('Проверка обновлений'));

    expect(onToggle).toHaveBeenCalledWith({ updatesCheck: true });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('отключение models.download: confirm «загрузка моделей станет недоступна» (golden §5)', () => {
    renderList();

    fireEvent.click(switchByName('Загрузка моделей ИИ'));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Загрузка моделей станет недоступна');
  });

  it('confirm-отмена: onToggle НЕ вызван, диалог закрыт (AC4-дефолт)', () => {
    const onToggle = renderList();

    fireEvent.click(switchByName('Загрузка моделей ИИ'));
    fireEvent.click(screen.getByTestId('privacy-confirm-cancel'));

    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('confirm-подтверждение: onToggle c patch modelsDownload:false (§5)', () => {
    const onToggle = renderList();

    fireEvent.click(switchByName('Загрузка моделей ИИ'));
    fireEvent.click(screen.getByTestId('privacy-confirm-accept'));

    expect(onToggle).toHaveBeenCalledWith({ modelsDownload: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('OperationsList — блокировка при активной загрузке (§13/§10/§19)', () => {
  it('modelsDownload disabled + tooltip «идёт загрузка»; updatesCheck активен', () => {
    renderList({ downloadInProgress: true });

    const modelsSwitch = switchByName('Загрузка моделей ИИ');
    expect(modelsSwitch.hasAttribute('disabled')).toBe(true);
    expect(modelsSwitch.getAttribute('title')).toContain('загрузк');
    expect(switchByName('Проверка обновлений').hasAttribute('disabled')).toBe(false);
  });

  it('без загрузки — оба переключателя активны', () => {
    renderList({ downloadInProgress: false });

    expect(switchByName('Загрузка моделей ИИ').hasAttribute('disabled')).toBe(false);
    expect(switchByName('Проверка обновлений').hasAttribute('disabled')).toBe(false);
  });
});

describe('OperationsList — неизвестная операция (честность, §13-дух)', () => {
  it('raw-name вместо выдуманного названия, описания нет, переключение — no-op patch', () => {
    const onToggle = renderList({
      ops: [
        {
          op: 'future.op',
          consentKey: 'futureKey',
          descriptionKey: 'privacy.ops.future_op',
          enabled: false,
        },
      ],
    });

    const sw = screen.getByRole('switch', { name: 'future.op' });
    expect(sw).toBeDefined();
    expect(screen.queryByText('Скачивает файлы локальных ИИ-моделей с CDN по вашему запросу')).toBeNull();

    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith({});
  });
});
