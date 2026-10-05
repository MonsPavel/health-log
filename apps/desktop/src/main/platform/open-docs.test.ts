// TASK-113 (ревью ветки): юнит defaultDocsRoot — корень руководства обязан
// резолвиться в существующий docs/user РЕПОЗИТОРИЯ из раскладки скомпилированного
// модуля. Баг ревью: '../../../../docs/user' от dist/main/platform/open-docs.js —
// четыре уровня вверх дают <repo>/apps/ (resolved = <repo>/apps/docs/user,
// exists: false — проверено node против собранного файла) → ветка shell.openPath
// хендлера мертва в dev/e2e, каждый клик «Помощи» уходит в openExternal на GitHub.
// Раскладки src/main/platform и dist/main/platform лежат на ОДНОЙ глубине под
// apps/desktop (tsc без бандлинга сохраняет структуру), поэтому проверка на
// исходнике в vitest воспроизводит арифметику сборки: корень = ПЯТЬ уровней вверх.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultDocsRoot } from './open-docs.js';

describe('defaultDocsRoot — корень руководства (ревью ветки TASK-113)', () => {
  it('резолвится в существующий docs/user репозитория, а не <repo>/apps/docs/user', () => {
    const docsRoot = defaultDocsRoot();

    // Оглавление руководства физически лежит в репозитории — путь обязан на него
    // указывать (иначе existsSync в обвязке контейнера всегда false и ветка
    // shell.openPath хендлера недостижима в dev/e2e).
    expect(existsSync(join(docsRoot, 'index.md')), docsRoot).toBe(true);
    expect(existsSync(join(docsRoot, 'faq.md')), docsRoot).toBe(true);
  });

  it('не указывает внутрь apps/ (маркер неверной арифметики уровней)', () => {
    const docsRoot = defaultDocsRoot();
    // Нормализованный путь не содержит сегмента apps/docs (результат 4 уровней).
    expect(docsRoot.replaceAll('\\', '/')).not.toContain('/apps/docs/');
  });
});
