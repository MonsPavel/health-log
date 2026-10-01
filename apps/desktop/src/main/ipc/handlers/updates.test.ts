// TASK-096 §19: юниты тонких хендлеров updates/* (прецедент ai-models.test.ts):
// маппинг вызова канала на UpdatesService; валидацию payload делает каркас TASK-008.
import { describe, expect, it, vi } from 'vitest';

import {
  createUpdatesCheckHandler,
  createUpdatesDownloadHandler,
  createUpdatesInstallHandler,
} from './updates.js';
import type { UpdatesService } from '../../modules/platform-services/updates/updates-service.js';

/** Fake-сервис: шпионы наружу переменными (unbound-method — методы класса не референсим). */
const makeService = (): {
  service: UpdatesService;
  check: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
} => {
  const check = vi.fn(() => Promise.resolve({ status: 'latest' }));
  const download = vi.fn(() => Promise.resolve({ status: 'ready', version: '1.2.3' }));
  const install = vi.fn(() => Promise.resolve({ restarting: true }));
  return {
    check,
    download,
    install,
    service: { check, download, install } as unknown as UpdatesService,
  };
};

describe('хендлеры updates/* (TASK-096 §11)', () => {
  it('updates/check → service.check()', async () => {
    const { service, check } = makeService();
    await expect(createUpdatesCheckHandler(service)({})).resolves.toEqual({ status: 'latest' });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('updates/download → service.download()', async () => {
    const { service, download } = makeService();
    await expect(createUpdatesDownloadHandler(service)({})).resolves.toEqual({
      status: 'ready',
      version: '1.2.3',
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('updates/install → service.install()', async () => {
    const { service, install } = makeService();
    await expect(createUpdatesInstallHandler(service)({})).resolves.toEqual({ restarting: true });
    expect(install).toHaveBeenCalledTimes(1);
  });
});
