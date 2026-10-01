// TASK-096 §19: юниты тонких хендлеров updates/* (прецедент ai-models.test.ts):
// маппинг вызова канала на UpdatesService; валидацию payload делает каркас TASK-008.
import { describe, expect, it, vi } from 'vitest';

import { createUpdatesCheckHandler, createUpdatesDownloadHandler, createUpdatesInstallHandler } from './updates.js';
import type { UpdatesService } from '../../modules/platform-services/updates/updates-service.js';

const makeService = (): UpdatesService & {
  check: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
} =>
  ({
    check: vi.fn(() => Promise.resolve({ status: 'latest' })),
    download: vi.fn(() => Promise.resolve({ status: 'ready', version: '1.2.3' })),
    install: vi.fn(() => Promise.resolve({ restarting: true })),
    getStatus: vi.fn(),
  }) as never;

describe('хендлеры updates/* (TASK-096 §11)', () => {
  it('updates/check → service.check()', async () => {
    const service = makeService();
    await expect(createUpdatesCheckHandler(service)({})).resolves.toEqual({ status: 'latest' });
    expect(service.check).toHaveBeenCalledTimes(1);
  });

  it('updates/download → service.download()', async () => {
    const service = makeService();
    await expect(createUpdatesDownloadHandler(service)({})).resolves.toEqual({
      status: 'ready',
      version: '1.2.3',
    });
    expect(service.download).toHaveBeenCalledTimes(1);
  });

  it('updates/install → service.install()', async () => {
    const service = makeService();
    await expect(createUpdatesInstallHandler(service)({})).resolves.toEqual({ restarting: true });
    expect(service.install).toHaveBeenCalledTimes(1);
  });
});
