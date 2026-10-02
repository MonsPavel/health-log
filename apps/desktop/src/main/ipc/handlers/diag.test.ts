/**
 * TASK-103 §19: юниты тонких хендлеров diag/* (прецедент privacy.test.ts):
 * маппинг вызова канала на DiagBundleService; валидацию payload делает каркас
 * TASK-008 до хендлера. Каркас-путь (strict/secure) — здесь же через реестр.
 */
import { describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS, type DiagContent } from '@hl/contracts';

import type { DiagBundleService } from '../../modules/platform-services/diag/diag-service.js';
import { createChannelRegistry } from '../register-channel.js';
import { createDiagPreviewHandler, createDiagSaveHandler } from './diag.js';

const CONTENT: DiagContent = {
  files: [{ name: 'hl.1.log', sizeBytes: 10, preview: 'line' }],
  totals: { eventsByKind: {} },
};

/** Fake-сервис: шпионы наружу переменными (unbound-method — методы класса не референсим). */
function makeService(): {
  service: DiagBundleService;
  collect: ReturnType<typeof vi.fn>;
  saveBundle: ReturnType<typeof vi.fn>;
} {
  const collect = vi.fn(() => Promise.resolve(CONTENT));
  const saveBundle = vi.fn(() => Promise.resolve({ saved: true, path: 'D:\\x.zip' }));
  return {
    collect,
    saveBundle,
    service: { collect, saveBundle } as unknown as DiagBundleService,
  };
}

describe('хендлеры diag/* (TASK-103 §11)', () => {
  it('diag/preview: {} → collect() (предпросмотр ДО сохранения, AC §20-3 main-сторона)', async () => {
    const { service, collect } = makeService();
    const handler = createDiagPreviewHandler(service);
    await expect(handler({})).resolves.toEqual(CONTENT);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledWith();
  });

  it('diag/save: outcome saved → {path} (union 065)', async () => {
    const { service, saveBundle } = makeService();
    const handler = createDiagSaveHandler(service);
    await expect(handler({})).resolves.toEqual({ path: 'D:\\x.zip' });
    expect(saveBundle).toHaveBeenCalledTimes(1);
  });

  it('diag/save: отмена диалога → {canceled: true} (§7 065 — не ошибка)', async () => {
    const { service } = makeService();
    (service as unknown as { saveBundle: ReturnType<typeof vi.fn> }).saveBundle = vi.fn(() =>
      Promise.resolve({ saved: false, canceled: true }),
    );
    const handler = createDiagSaveHandler(service);
    await expect(handler({})).resolves.toEqual({ canceled: true });
  });

  it('каркас (§11): каналы зарегистрированы secure — при locked конверт VAULT/LOCKED ДО хендлера', async () => {
    const { service, collect } = makeService();
    const channels = createChannelRegistry(
      { warn: () => undefined, error: () => undefined },
      { isUnlocked: () => false, onActivity: () => undefined },
    );
    channels.register(
      'diag/preview',
      CHANNEL_SCHEMAS['diag/preview'],
      createDiagPreviewHandler(service),
    );
    channels.register('diag/save', CHANNEL_SCHEMAS['diag/save'], createDiagSaveHandler(service));

    const envelope = await channels.dispatch({ channel: 'diag/preview', payload: {} });
    expect(envelope).toMatchObject({ ok: false, error: { code: 'VAULT/LOCKED' } });
    expect(collect).not.toHaveBeenCalled(); // гвардия ДО хендлера (§7 каркаса)
  });
});
