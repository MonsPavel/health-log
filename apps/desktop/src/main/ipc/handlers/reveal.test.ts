// TASK-068 §5/§11: юниты хендлера `app/reveal-path` — «открыть папку» после
// сохранения (shell.showItemInFolder). Хендлер тонкий: вызывает внедрённую функцию
// reveal с путём payload'а и возвращает null (fire-and-forget, §9); сбой reveal
// НЕ ошибка канала для UI (UX-удобство, §11) — его глушит боевая обвязка контейнера,
// здесь проверяется только прокидывание пути.
import { describe, expect, it, vi } from 'vitest';

import { createRevealPathHandler } from './reveal.js';

describe('createRevealPathHandler — {path} → null (§11)', () => {
  it('вызывает reveal с путём payload\'а и отвечает null', () => {
    const reveal = vi.fn();
    const handler = createRevealPathHandler(reveal);

    expect(handler({ path: 'C:\\out\\report.pdf' })).toBeNull();
    expect(reveal).toHaveBeenCalledWith('C:\\out\\report.pdf');
  });

  it('каждый вызов — свежий reveal (кнопка «Открыть папку» нажимается повторно)', () => {
    const reveal = vi.fn();
    const handler = createRevealPathHandler(reveal);

    handler({ path: 'C:\\a.pdf' });
    handler({ path: 'C:\\b.pdf' });

    expect(reveal).toHaveBeenCalledTimes(2);
  });
});
