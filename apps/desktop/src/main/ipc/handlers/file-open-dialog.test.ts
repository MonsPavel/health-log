// TASK-073 §5/§9/§19: юниты хендлера `file/open-dialog` — выбор файла копии для
// восстановления. Хендлер тонкий (прецедент reveal.ts): передаёт фильтры payload'а
// внедрённому адаптеру open-диалога и возвращает его ответ как есть — {path} |
// {canceled: true} (§7: отмена — не ошибка). Боевой адаптер (electron dialog)
// инъекцируется контейнером; мокается здесь.
import { describe, expect, it, vi } from 'vitest';

import type { FileOpenDialogRequest, FileOpenDialogResponse } from '@hl/contracts';

import { createFileOpenDialogHandler } from './file-open-dialog.js';

const REQUEST: FileOpenDialogRequest = {
  filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
};

describe('createFileOpenDialogHandler — {filters} → {path} | {canceled} (§9)', () => {
  it('выбранный файл → {path}: фильтры переданы адаптеру, ответ как есть', async () => {
    const openFile = vi.fn(() => Promise.resolve({ path: 'C:\\copies\\x.hlbackup' }));
    const handler = createFileOpenDialogHandler(openFile);

    await expect(handler(REQUEST)).resolves.toEqual({ path: 'C:\\copies\\x.hlbackup' });
    expect(openFile).toHaveBeenCalledWith(REQUEST.filters);
  });

  it('отмена диалога → {canceled: true} без ошибки (§7)', async () => {
    const openFile = vi.fn(
      () => Promise.resolve({ canceled: true }) as Promise<FileOpenDialogResponse>,
    );
    const handler = createFileOpenDialogHandler(openFile);

    await expect(handler(REQUEST)).resolves.toEqual({ canceled: true });
  });
});
