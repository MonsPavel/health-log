/**
 * Хендлер канала `app/open-docs` (TASK-113 §5/§8–12): «Помощь» экрана настроек
 * открывает страницу руководства пользователя docs/user. Слой тонкий (прецедент
 * reveal.ts): zod-валидацию payload'а (whitelist DOC_PAGES — ЕДИНСТВЕННАЯ
 * санитизация page, §8–12) делает каркас TASK-008 до вызова хендлера.
 *
 * Ветвление (§4: «открытие docs/user в браузере/проводнике»):
 *  - локальный файл руководства существует (репозиторий/dev) → openPath
 *    (shell.openPath — системный обработчик .md);
 *  - файла нет (packaged-сборка: исходники в установщик не входят) →
 *    openExternal на страницу docs/user в репозитории (браузер).
 *
 * Ответ null — fire-and-forget (§9, прецедент app/reveal-path); сбой открытия —
 * НЕ ошибка канала для UI, его глушит боевая обвязка контейнера warn-логом.
 */
import type { AppOpenDocsRequest, DocPage } from '@hl/contracts';

/** Порты хендлера (боевые — electron shell, main/platform; тесты — vi.fn, §19). */
export interface OpenDocsPorts {
  /** Локальный путь страницы руководства (main строит сам — renderer пути не знает, §14). */
  readonly resolveDocPath: (page: DocPage) => string;
  /** Существует ли локальный файл (packaged: docs вне установщика → false). */
  readonly fileExists: (path: string) => boolean;
  /** Открыть локальный файл (боевой — shell.openPath). */
  readonly openPath: (path: string) => Promise<unknown>;
  /** Открыть URL в системном браузере (боевой — shell.openExternal). */
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Базовый URL документации в репозитории (fallback; дефолт — константа ниже). */
  readonly repoDocsBaseUrl?: string;
}

/**
 * Дефолтный базовый URL страниц руководства (§4 «гиперссылка на файл/репозиторий»):
 * GitHub репозитория проекта — тот же источник, что publish-фиды electron-builder
 * (TASK-104). Браузер рендерит markdown сам — .md открывается читабельно.
 */
export const DEFAULT_REPO_DOCS_BASE_URL =
  'https://github.com/MonsPavel/health-log/blob/main/docs/user';

/** Страница → URL файла .md в docs/user репозитория (fallback, §4). */
export function docsPageUrl(baseUrl: string, page: DocPage): string {
  return `${baseUrl}/${page}.md`;
}

/** Фабрика хендлера `app/open-docs`: {page} → null (§8–12/§9). */
export function createOpenDocsHandler(ports: OpenDocsPorts): (payload: AppOpenDocsRequest) => null {
  return (payload) => {
    const localPath = ports.resolveDocPath(payload.page);
    if (ports.fileExists(localPath)) {
      // Promise не ждём — fire-and-forget; отказ глушит обвязка контейнера (§9).
      void ports.openPath(localPath);
    } else {
      void ports.openExternal(
        docsPageUrl(ports.repoDocsBaseUrl ?? DEFAULT_REPO_DOCS_BASE_URL, payload.page),
      );
    }
    return null;
  };
}
