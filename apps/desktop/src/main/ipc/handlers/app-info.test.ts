// TASK-100 §11/§19: юниты тонких хендлеров app/selfcheck|meta|integrity-full
// (прецедент privacy.test.ts): маппинг вызова канала на SelfCheckService/порты;
// валидацию payload делает каркас TASK-008 до вызова хендлера.
import { describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS, type SelfCheckReport } from '@hl/contracts';

import type { SelfCheckService } from '../../app/selfcheck.js';
import { createChannelRegistry } from '../register-channel.js';
import {
  createAppIntegrityFullHandler,
  createAppMetaHandler,
  createAppSelfcheckHandler,
} from './app-info.js';

const HEALTHY: SelfCheckReport = {
  dbOk: true,
  schemaVersion: 9,
  vaultMode: 'none',
  worker: { state: 'starting' },
  prefsOk: true,
  checkedAtUtc: 1_758_816_000_000,
  startupMs: 7,
};

/** Fake-сервис: шпионы наружу (unbound-method — методы класса не референсим). */
const makeService = (report: SelfCheckReport | undefined = HEALTHY): {
  service: SelfCheckService;
  runFullIntegrity: ReturnType<typeof vi.fn>;
} => {
  const runFullIntegrity = vi.fn(() => Promise.resolve({ ok: true, details: 'ok' }));
  return {
    runFullIntegrity,
    service: {
      get report() {
        return report;
      },
      runFullIntegrity,
    } as unknown as SelfCheckService,
  };
};

describe('хендлеры app-info (TASK-100 §11)', () => {
  it('app/selfcheck: отчёт из памяти сервиса; null — самчек ещё не выполнялся', async () => {
    const { service } = makeService(HEALTHY);
    const handler = createAppSelfcheckHandler(service);
    await expect(handler({})).resolves.toBe(HEALTHY);

    const fresh = makeService(undefined);
    await expect(createAppSelfcheckHandler(fresh.service)({})).resolves.toBeNull();
  });

  it('app/meta: версии из портов; модель без id (или без версии) — поле опущено (§5 «если есть»)', async () => {
    const { service } = makeService(HEALTHY);
    const scales = vi.fn(() => Promise.resolve({ code: 'BP-OFFICE-ESC2018', version: '1.0.0' }));
    const model = vi.fn(() => Promise.resolve({ modelId: 'qwen3-4b', modelVersion: '1.0' }));
    const handler = createAppMetaHandler({
      appVersion: '0.1.0',
      selfcheck: service,
      scales,
      model,
    });

    await expect(handler({})).resolves.toEqual({
      appVersion: '0.1.0',
      schemaVersion: 9,
      scale: { code: 'BP-OFFICE-ESC2018', version: '1.0.0' },
      model: { id: 'qwen3-4b', version: '1.0' },
    });
  });

  it('app/meta: modelId "" — model не входит в ответ (модель не выбрана); version "" — тоже', async () => {
    const { service } = makeService(HEALTHY);
    const scales = vi.fn(() => Promise.resolve({ code: 'S', version: '1' }));
    const noModel = createAppMetaHandler({
      appVersion: '1',
      selfcheck: service,
      scales,
      model: vi.fn(() => Promise.resolve({ modelId: '', modelVersion: '' })),
    });
    const parsed = CHANNEL_SCHEMAS['app/meta'].response.parse(await noModel({}));
    expect('model' in parsed).toBe(false);

    // Модель выбрана, но дескриптор не найден (version '') — без честной версии
    // строка не рисуется (контракт требует id+version, §5).
    const noVersion = createAppMetaHandler({
      appVersion: '1',
      selfcheck: service,
      scales,
      model: vi.fn(() => Promise.resolve({ modelId: 'qwen3-4b', modelVersion: '' })),
    });
    const parsedNoVersion = CHANNEL_SCHEMAS['app/meta'].response.parse(await noVersion({}));
    expect('model' in parsedNoVersion).toBe(false);
  });

  it('app/integrity-full: вызов порта runFullIntegrity, ответ без изменений', async () => {
    const { service, runFullIntegrity } = makeService();
    const handler = createAppIntegrityFullHandler(service);
    await expect(handler({})).resolves.toEqual({ ok: true, details: 'ok' });
    expect(runFullIntegrity).toHaveBeenCalledTimes(1);
  });

  it('каркас: ответ app/selfcheck валиден по схеме (report|null), payload {} strict', async () => {
    const { service } = makeService();
    const registry = createChannelRegistry();
    registry.register(
      'app/selfcheck',
      CHANNEL_SCHEMAS['app/selfcheck'],
      createAppSelfcheckHandler(service),
    );
    registry.register(
      'app/meta',
      CHANNEL_SCHEMAS['app/meta'],
      createAppMetaHandler({
        appVersion: '1',
        selfcheck: service,
        scales: vi.fn(() => Promise.resolve({ code: 'S', version: '1' })),
        model: vi.fn(() => Promise.resolve({ modelId: '', modelVersion: '' })),
      }),
    );
    registry.register(
      'app/integrity-full',
      CHANNEL_SCHEMAS['app/integrity-full'],
      createAppIntegrityFullHandler(service),
    );

    const selfcheckEnvelope = await registry.dispatch({ channel: 'app/selfcheck', payload: {} });
    expect(selfcheckEnvelope.ok).toBe(true);
    const metaEnvelope = await registry.dispatch({ channel: 'app/meta', payload: {} });
    expect(metaEnvelope.ok).toBe(true);
    const integrityEnvelope = await registry.dispatch({
      channel: 'app/integrity-full',
      payload: {},
    });
    expect(integrityEnvelope.ok).toBe(true);

    // Лишние поля в запросе — VALIDATION до хендлера (§14).
    const bad = await registry.dispatch({ channel: 'app/selfcheck', payload: { x: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('VALIDATION/FAILED');
    }
  });
});
