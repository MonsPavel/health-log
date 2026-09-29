// TASK-073 §5/§9/§19: юниты боевого адаптера file/open — dialog.showOpenDialog
// Electron. Electron мокается целиком (vi.hoisted — прецедент
// reporting-export-csv.int.test.ts): адаптер импортирует electron ЛЕНИВО внутри
// openFile(), статического импорта в графе main нет.
//
// Матрица (§9/§7):
//  - выбранный файл → {path} (полный путь — выбор пользователя, наружу можно §14);
//  - отмена/пустой список → {canceled: true} (§7: ожидаемый исход, не ошибка);
//  - фильтры payload'а доходят до диалога (name+extensions) + properties openFile;
//  - electron без dialog (вне рантайма) → честное исключение, не тихий сбой.
import { describe, expect, it, vi } from 'vitest';

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog } }));

import { electronFileOpenDialog } from './file-open.js';

const BACKUP_FILTERS = [{ name: 'Health Log Backup', extensions: ['hlbackup'] }];

describe('electronFileOpenDialog — dialog.showOpenDialog → {path} | {canceled} (§9)', () => {
  it('выбранный файл → {path}: полный путь как результат диалога ОС', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\copies\\x.hlbackup'] });

    await expect(electronFileOpenDialog(BACKUP_FILTERS)).resolves.toEqual({
      path: 'C:\\copies\\x.hlbackup',
    });
    expect(showOpenDialog).toHaveBeenCalledWith({
      filters: BACKUP_FILTERS,
      properties: ['openFile'],
    });
  });

  it('отмена пользователя → {canceled: true} (§7); пустой filePaths — тоже отмена', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(electronFileOpenDialog(BACKUP_FILTERS)).resolves.toEqual({ canceled: true });

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(electronFileOpenDialog(BACKUP_FILTERS)).resolves.toEqual({ canceled: true });
  });

  it('dialog недоступен (запуск вне Electron) — честное исключение, не тихий сбой', async () => {
    vi.doMock('electron', () => ({}));
    try {
      const { electronFileOpenDialog: fresh } = await import('./file-open.js');
      await expect(fresh(BACKUP_FILTERS)).rejects.toThrow('dialog.showOpenDialog недоступен');
    } finally {
      vi.doUnmock('electron');
    }
  });
});
