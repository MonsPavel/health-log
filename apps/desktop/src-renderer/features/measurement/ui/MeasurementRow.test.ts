/**
 * TASK-038 §5/§16/§19: тест строки журнала с меню действий — триггер ⋮ с
 * доступным именем и data-row-menu (якорь фокус-возврата экрана); «Изменить»/
 * «Удалить» вызывают onRowAction с самой записью (memo-дружественный единственный
 * колбэк — прецедент §15: стабильная идентичность между рендерами).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import '../../../i18n';
import { MeasurementRow } from './MeasurementRow';

const DTO: MeasurementDto = {
  id: 'm-1',
  profileId: 'seed-profile-0001',
  sys: 125,
  dia: 82,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  takenAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
  tzOffsetMin: 180,
  source: 'manual',
  createdAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
  updatedAtUtcMs: Date.UTC(2026, 8, 24, 18, 30),
};

afterEach(() => {
  cleanup();
});

describe('MeasurementRow — меню действий (TASK-038 §5/§16)', () => {
  it('в строке есть триггер ⋮ с data-row-menu=id записи', () => {
    render(createElement(MeasurementRow, { measurement: DTO, onRowAction: () => undefined }));

    const trigger = screen.getByRole('button', { name: 'Действия с записью' });
    expect(trigger.getAttribute('data-row-menu')).toBe('m-1');
  });

  it('«Изменить» → onRowAction(measurement, «edit»); «Удалить» → «delete» (§5)', async () => {
    const user = userEvent.setup();
    const onRowAction = vi.fn();
    render(createElement(MeasurementRow, { measurement: DTO, onRowAction }));
    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));
    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());

    await user.click(screen.getByTestId('row-menu-edit'));

    expect(onRowAction).toHaveBeenCalledTimes(1);
    expect(onRowAction).toHaveBeenCalledWith(DTO, 'edit');

    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));
    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());
    await user.click(screen.getByTestId('row-menu-delete'));

    expect(onRowAction).toHaveBeenCalledTimes(2);
    expect(onRowAction).toHaveBeenLastCalledWith(DTO, 'delete');
  });

  it('без onRowAction строка рендерится (меню без действия — no-op)', async () => {
    const user = userEvent.setup();
    render(createElement(MeasurementRow, { measurement: DTO }));

    await user.click(screen.getByRole('button', { name: 'Действия с записью' }));
    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());

    await user.click(screen.getByTestId('row-menu-edit'));

    expect(screen.getByTestId('measurement-row')).toBeDefined();
  });
});
