/**
 * TASK-113 §5/§8–12: контракт канала `app/open-docs` — «Помощь» экрана настроек
 * открывает страницу руководства пользователя `docs/user` (линк из приложения —
 * точка интеграции, §4).
 *
 * ЗАПРОС — `{page}`: страница руководства, санитизация — ТОЛЬКО whitelist'ом
 * (§8–12 спеки: «open-path — только на собственный каталог docs, санитизация
 * page-параметра whitelist'ом страниц»): z.enum из DOC_PAGES — произвольный путь,
 * обход каталогов и расширения отклоняются каркасом TASK-008 конвертом
 * VALIDATION/FAILED до хендлера. Путь к файлу строит main (renderer пути не знает
 * и не присылает — §14, прецедент app/reveal-backups).
 *
 * ОТВЕТ — null: канал fire-and-forget (§9, прецедент app/reveal-path) — сбой
 * открытия (проводник/ассоциация .md недоступны) НЕ ошибка канала для UI; его
 * глушит боевая обвязка контейнера warn-логом.
 *
 * НЕ secure: БД не читает, PHI/путей не содержит (§14).
 */
import { z } from 'zod';

/**
 * Страницы руководства (§5): имена файлов `docs/user/<page>.md`. Порядок —
 * оглавление index.md. Новая страница = правка enum + файл руководства.
 */
export const DOC_PAGES = ['index', 'install', 'daily', 'ai', 'data', 'privacy', 'faq'] as const;

/** Страница руководства — элемент whitelist'а (санитизация §8–12). */
export type DocPage = (typeof DOC_PAGES)[number];

/** Запрос `app/open-docs`: {page} — страница руководства (whitelist). */
export const APP_OPEN_DOCS_REQUEST_SCHEMA = z
  .object({
    page: z.enum(DOC_PAGES),
  })
  .strict();

/** Ответ `app/open-docs` — null (fire-and-forget, прецедент app/reveal-path). */
export const APP_OPEN_DOCS_RESPONSE_SCHEMA = z.null();

/** Запрос app/open-docs — {page} (whitelist DOC_PAGES, §8–12). */
export type AppOpenDocsRequest = z.output<typeof APP_OPEN_DOCS_REQUEST_SCHEMA>;

/** Ответ app/open-docs — null. */
export type AppOpenDocsResponse = z.output<typeof APP_OPEN_DOCS_RESPONSE_SCHEMA>;
