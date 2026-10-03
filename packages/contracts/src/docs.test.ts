// TASK-113 §19: юнит whitelist канала `app/open-docs` — ЕДИНСТВЕННАЯ санитизация
// page-параметра: zod-enum DOC_PAGE_SCHEMA (§8–12 спеки: «санитизация page-параметра
// whitelist'ом страниц»). Каркас TASK-008 валидирует payload схемой ДО вызова
// хендлера — неизвестная страница не доходит до открытия файла (VALIDATION/FAILED).
import { describe, expect, it } from 'vitest';

import { APP_OPEN_DOCS_REQUEST_SCHEMA, DOC_PAGES } from './docs.js';
import { CHANNEL_SCHEMAS } from './schemas.js';

describe('DOC_PAGES — whitelist страниц руководства (TASK-113 §5)', () => {
  it('ровно 7 страниц docs/user — имена совпадают с файлами руководства', () => {
    expect([...DOC_PAGES]).toEqual(['index', 'install', 'daily', 'ai', 'data', 'privacy', 'faq']);
  });
});

describe('APP_OPEN_DOCS_REQUEST_SCHEMA — whitelist как единственная санитизация (§14)', () => {
  it('принимает каждую страницу whitelist’а', () => {
    for (const page of DOC_PAGES) {
      expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page }).success).toBe(true);
    }
  });

  it('отклоняет неизвестную страницу и путь-обход (…/…, ..\\, слэши, расширение)', () => {
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: 'secret' }).success).toBe(false);
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: '../vault.key' }).success).toBe(false);
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: 'daily.md' }).success).toBe(false);
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: 'ai/../../data' }).success).toBe(false);
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: 'C:\\docs\\faq' }).success).toBe(false);
  });

  it('strict: лишнее поле и отсутствие page — отклонение', () => {
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: 'faq', extra: 1 }).success).toBe(false);
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(APP_OPEN_DOCS_REQUEST_SCHEMA.safeParse({ page: 42 }).success).toBe(false);
  });

  it('ответ — null (fire-and-forget, прецедент app/reveal-path)', () => {
    expect(CHANNEL_SCHEMAS['app/open-docs']?.response.safeParse(null).success).toBe(true);
    expect(CHANNEL_SCHEMAS['app/open-docs']?.response.safeParse({}).success).toBe(false);
  });
});
