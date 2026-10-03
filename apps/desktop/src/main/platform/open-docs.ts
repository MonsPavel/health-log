/**
 * TASK-113 §4/§6: боевой адаптер открытия руководства поверх Electron shell —
 * shell.openPath (локальный файл docs/user/<page>.md) и shell.openExternal
 * (страница репозитория, когда локального файла нет). Electron импортируется
 * ЛЕНИВО внутри функции (§20-прецедент reveal-path.ts): в node-окружении vitest
 * адаптер не вызывается (обвязка контейнера глушит отказ — канал fire-and-forget
 * §9), статического импорта electron в графе модулей нет.
 *
 * БЕЗОПАСНОСТЬ (§8–12): открывается ТОЛЬКО собственный каталог docs — page
 * приходит уже санитизированным whitelist'ом DOC_PAGES (каркас TASK-008), путь
 * строит main из известного корня, произвольный путь невозможен.
 */
import { fileURLToPath } from 'node:url';

/** Минимальная поверхность shell для открытия документов (structural, §19-прецедент). */
export interface OpenDocsShellApi {
  /** shell.openPath: '' — успех, непустая строка — сообщение об ошибке платформы. */
  openPath(fullPath: string): Promise<string>;
  /** shell.openExternal: открыть URL системным браузером. */
  openExternal(url: string): Promise<void>;
}

/**
 * Корень руководства по умолчанию — относительно этого модуля: в dev раскладка
 * dist/main/platform/open-docs.js → ПЯТЬ уровней вверх (platform → main → dist →
 * apps/desktop → apps → корень репозитория) = <repo>/docs/user (§4: «открытие
 * docs/user в браузере/проводнике»). Арифметика покрыта тестом open-docs.test.ts:
 * ревью ветки поймало «четыре уровня» → <repo>/apps/docs/user (exists: false,
 * ветка shell.openPath мертва). Раскладки src/main/platform и dist/main/platform
 * лежат на одной глубине под apps/desktop — проверка на исходнике легитимна и для
 * сборки. В packaged сборке модуль живёт в app.asar, docs/user туда не входит —
 * existsSync даст false и хендлер уйдёт в openExternal на репозиторий (§4).
 */
export function defaultDocsRoot(): string {
  return fileURLToPath(new URL('../../../../../docs/user', import.meta.url));
}

/** Боевой адаптер (§5): открыть локальный файл системным обработчиком. */
export async function electronOpenDocFile(path: string): Promise<void> {
  const electron = await import('electron');
  const shell = (electron as { shell?: OpenDocsShellApi }).shell;
  if (shell === undefined) {
    throw new Error('electronOpenDocFile: shell.openPath недоступен (запуск вне Electron?)');
  }
  const failure = await shell.openPath(path);
  if (failure !== '') {
    // openPath НЕ реджектится — ошибка платформы приходит строкой; поднимаем,
    // чтобы обвязка контейнера записала warn (§18: без путей).
    throw new Error(failure);
  }
}

/** Боевой адаптер (§5): открыть страницу руководства в системном браузере. */
export async function electronOpenDocUrl(url: string): Promise<void> {
  const electron = await import('electron');
  const shell = (electron as { shell?: OpenDocsShellApi }).shell;
  if (shell === undefined) {
    throw new Error('electronOpenDocUrl: shell.openExternal недоступен (запуск вне Electron?)');
  }
  await shell.openExternal(url);
}
