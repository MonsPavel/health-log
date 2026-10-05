// TASK-113 §5/§19: юниты хендлера `app/open-docs` — «Помощь» экрана настроек
// открывает страницу руководства docs/user (§4: точка интеграции минимальна).
// Хендлер тонкий (прецедент reveal.ts): ветвление «локальный файл есть → openPath,
// нет → openExternal на страницу репозитория», ответ null (fire-and-forget, §9).
// Валидацию whitelist'ом делает каркас TASK-008 — второй прогон ниже через реестр.
import { describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS } from '@hl/contracts';

import { createChannelRegistry } from '../register-channel.js';
import { createOpenDocsHandler, DEFAULT_REPO_DOCS_BASE_URL, docsPageUrl } from './open-docs.js';

const BASE_PORTS = () => ({
  resolveDocPath: (page: string) => `D:\\repo\\docs\\user\\${page}.md`,
  fileExists: vi.fn(() => true),
  openPath: vi.fn(() => Promise.resolve(undefined)),
  openExternal: vi.fn(() => Promise.resolve(undefined)),
});

describe('createOpenDocsHandler — {page} → null (§9/§11)', () => {
  it('локальный файл существует → openPath с путём страницы; openExternal не зовётся', async () => {
    const ports = { ...BASE_PORTS(), fileExists: vi.fn(() => true) };
    const handler = createOpenDocsHandler(ports);

    expect(handler({ page: 'daily' })).toBeNull();
    expect(ports.fileExists).toHaveBeenCalledWith('D:\\repo\\docs\\user\\daily.md');
    expect(ports.openPath).toHaveBeenCalledTimes(1);
    expect(ports.openPath).toHaveBeenCalledWith('D:\\repo\\docs\\user\\daily.md');
    expect(ports.openExternal).not.toHaveBeenCalled();
    await Promise.resolve();
  });

  it('локального файла нет (packaged-сборка) → openExternal на страницу репозитория', () => {
    const ports = { ...BASE_PORTS(), fileExists: vi.fn(() => false) };
    const handler = createOpenDocsHandler(ports);

    expect(handler({ page: 'faq' })).toBeNull();
    expect(ports.openPath).not.toHaveBeenCalled();
    expect(ports.openExternal).toHaveBeenCalledWith(`${DEFAULT_REPO_DOCS_BASE_URL}/faq.md`);
  });

  it('каждый вызов — свежее открытие (кнопка «Помощь» нажимается повторно)', async () => {
    const ports = BASE_PORTS();
    const handler = createOpenDocsHandler(ports);

    handler({ page: 'index' });
    handler({ page: 'install' });
    await Promise.resolve();

    expect(ports.openPath).toHaveBeenCalledTimes(2);
  });
});

describe('docsPageUrl / DEFAULT_REPO_DOCS_BASE_URL — fallback на репозиторий (§4)', () => {
  it('страница → URL .md в docs/user репозитория', () => {
    expect(docsPageUrl('https://example.com/docs/user', 'ai')).toBe(
      'https://example.com/docs/user/ai.md',
    );
  });

  it('дефолт — GitHub репозитория проекта (прецедент publish-фиду electron-builder)', () => {
    expect(DEFAULT_REPO_DOCS_BASE_URL).toBe(
      'https://github.com/MonsPavel/health-log/blob/main/docs/user',
    );
  });
});

describe('whitelist через каркас TASK-008 (§19: канал open-docs — юнит whitelist)', () => {
  it('страница whitelist’а доходит до хендлера', async () => {
    const handler = vi.fn(() => null);
    const registry = createChannelRegistry();
    registry.register('app/open-docs', CHANNEL_SCHEMAS['app/open-docs'], handler);

    const envelope = await registry.dispatch({ channel: 'app/open-docs', payload: { page: 'ai' } });

    expect(envelope.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ page: 'ai' });
  });

  it('страница вне whitelist’а — VALIDATION/FAILED, хендлер НЕ вызывается (§14)', async () => {
    const handler = vi.fn(() => null);
    const registry = createChannelRegistry();
    registry.register('app/open-docs', CHANNEL_SCHEMAS['app/open-docs'], handler);

    const envelope = await registry.dispatch({
      channel: 'app/open-docs',
      payload: { page: '../vault.key' },
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
