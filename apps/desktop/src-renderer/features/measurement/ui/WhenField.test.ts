/**
 * TASK-031 §5/§13/§16/§19: тест поля «когда измерено» — «сейчас» по Intl
 * (TASK-013 formatDateTime), кнопка «Изменить» → input type=date/time (TD-11),
 * префилл текущими датой/временем, возврат к «сейчас»; будущая дата —
 * клиентская ошибка подсветкой (aria-invalid + aria-describedby, §16).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { WhenField } from './WhenField';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 2026-09-25 21:00 UTC+3 → локальная стена 2026-09-25 21:00 (в тестах offset устройства). */
const NOW_MS = Date.UTC(2026, 8, 25, 18, 0, 0);

function renderWhen(props: Partial<Parameters<typeof WhenField>[0]> = {}): void {
  render(
    createElement(WhenField, {
      when: 'now',
      nowMs: NOW_MS,
      onNow: vi.fn(),
      onManual: vi.fn(),
      ...props,
    }),
  );
}

describe('WhenField — режим «сейчас» (§5)', () => {
  it('показывает текущее время по Intl (формат ru, TASK-013)', () => {
    renderWhen();

    // Настенная дата nowMs в зоне устройства; формат datetime-пресета ru-RU.
    const tzOffsetMin = -new Date(NOW_MS).getTimezoneOffset();
    const wall = new Date(NOW_MS + tzOffsetMin * 60_000);
    const expected = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'UTC',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(wall.getTime());
    expect(screen.getByText(expected)).toBeDefined();
  });

  it('кнопка «Изменить» → onManual с префиллом текущих даты/времени (input type=date/time)', () => {
    const onManual = vi.fn();
    renderWhen({ onManual });

    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));

    // Префилл — локальные компоненты nowMs (один сдвиг зоны, как в dateStringOf).
    const local = new Date(NOW_MS);
    const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    const time = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
    expect(onManual).toHaveBeenCalledWith(date, time);
  });
});

describe('WhenField — ручной ввод (заднее число разрешено, §5)', () => {
  it('поля дата/время с значениями черновика; подписи «Дата»/«Время»', () => {
    renderWhen({ when: { date: '2026-09-24', time: '21:30' } });

    const date = screen.getByLabelText<HTMLInputElement>('Дата');
    const time = screen.getByLabelText<HTMLInputElement>('Время');
    expect(date.type).toBe('date');
    expect(time.type).toBe('time');
    expect(date.value).toBe('2026-09-24');
    expect(time.value).toBe('21:30');
  });

  it('правка даты → onManual(новая дата, прежнее время)', () => {
    const onManual = vi.fn();
    renderWhen({ when: { date: '2026-09-24', time: '21:30' }, onManual });

    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-09-20' } });

    expect(onManual).toHaveBeenCalledWith('2026-09-20', '21:30');
  });

  it('кнопка «Вернуть «сейчас»» → onNow (§5: по умолчанию «сейчас»)', () => {
    const onNow = vi.fn();
    renderWhen({ when: { date: '2026-09-24', time: '21:30' }, onNow });

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть «сейчас»' }));

    expect(onNow).toHaveBeenCalledTimes(1);
  });

  it('ошибка futureTime: aria-invalid + aria-describedby с текстом на обоих полях (§16/§20)', () => {
    renderWhen({
      when: { date: '2099-01-01', time: '10:00' },
      error: { messageKey: 'errors.futureTime' },
    });

    for (const label of ['Дата', 'Время']) {
      const input = screen.getByLabelText(label);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toContain('when-error');
      expect(document.getElementById('when-error')?.textContent).toContain(
        'не может быть в будущем',
      );
    }
  });
});
