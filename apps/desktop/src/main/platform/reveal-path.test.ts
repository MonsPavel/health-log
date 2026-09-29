// TASK-068 §20-6 (автоматический эквивалент): последний непроверенный хоп цепочки
// «Открыть папки» — боевой адаптер electronRevealPath → shell.showItemInFolder.
// Electron мокается на уровне модуля (прецедент single-instance.test.ts,
// report.int.test.ts): проверяется, что адаптер передаёт в shell.showItemInFolder
// РОВНО тот путь, что пришёл из save-диалога (§5/§11), и что вне Electron-рантайма
// (shell недоступен) — честное исключение, а не тихий сбой (§9 прецедент
// ElectronFileSaver). Сам эффект ОС (окно проводника с подсвеченным файлом) —
// ручная приёмка §20-6/§24: headless-среда его не воспроизводит.
//
// TDD-заметка: адаптер реализован в TASK-068 (коммит e80326f) — тест GREEN с
// первого прогона; RED невозможен без поломки боевого кода (прецедент TASK-065
// file-op-queue: «реализация смержена — RED невозможен без поломки кода»).
import { describe, expect, it, vi } from 'vitest';

// Шпион shell — vi.hoisted (фабрика vi.mock поднимается выше const);
// getter в namespace — чтение holder.shell на момент ВЫЗОВА адаптера (оба кейса
// в одном файле без пересоздания мока).
const holder = vi.hoisted(() => ({
  shell: undefined as { showItemInFolder(path: string): void } | undefined,
}));
const { showItemInFolder } = vi.hoisted(() => ({ showItemInFolder: vi.fn() }));
vi.mock('electron', () => ({
  get shell(): unknown {
    return holder.shell;
  },
}));

import { electronRevealPath } from './reveal-path.js';

describe('electronRevealPath — боевой адаптер «Открыть папку» (TASK-068 §20-6)', () => {
  it('путь из save-диалога доходит до shell.showItemInFolder БЕЗ изменений (§5/§11)', async () => {
    holder.shell = { showItemInFolder };
    showItemInFolder.mockClear();

    await electronRevealPath('C:\\out\\health-log-export-20250925-1900.pdf');

    expect(showItemInFolder).toHaveBeenCalledTimes(1);
    expect(showItemInFolder).toHaveBeenCalledWith('C:\\out\\health-log-export-20250925-1900.pdf');
  });

  it('вне Electron-рантайма (shell недоступен) — честное исключение (не тихий сбой)', async () => {
    holder.shell = undefined;

    await expect(electronRevealPath('C:\\out\\x.pdf')).rejects.toThrow(
      /shell\.showItemInFolder недоступен/,
    );
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
