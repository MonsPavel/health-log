// TASK-098 §19: юниты тонких хендлеров privacy/* (прецедент updates.test.ts):
// маппинг вызова канала на PrivacyQueries; валидацию payload делает каркас TASK-008.
// Каркас-путь (strict patch → VALIDATION до хендлера) — здесь же через реестр.
import { describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS, type PrivacyJournalResponse } from '@hl/contracts';

import type { PrivacyQueries } from '../../modules/platform-services/application/privacy-queries.js';
import { createChannelRegistry } from '../register-channel.js';
import { createPrivacyConsentsHandler, createPrivacyJournalHandler } from './privacy.js';

const EMPTY_JOURNAL: PrivacyJournalResponse = { entries: [], ops: [] };

/** Fake-queries: шпионы наружу переменными (unbound-method — методы класса не референсим). */
const makeQueries = (): {
  queries: PrivacyQueries;
  journal: ReturnType<typeof vi.fn>;
  getConsents: ReturnType<typeof vi.fn>;
  patchConsents: ReturnType<typeof vi.fn>;
} => {
  const journal = vi.fn(() => Promise.resolve(EMPTY_JOURNAL));
  const getConsents = vi.fn(() => Promise.resolve({ updatesCheck: false, modelsDownload: false }));
  const patchConsents = vi.fn((patch: { updatesCheck?: boolean }) =>
    Promise.resolve({ updatesCheck: patch.updatesCheck ?? false, modelsDownload: false }),
  );
  return {
    journal,
    getConsents,
    patchConsents,
    queries: { journal, getConsents, patchConsents } as unknown as PrivacyQueries,
  };
};

describe('хендлеры privacy/* (TASK-098 §11)', () => {
  it('privacy/journal: limit из запроса проходит в queries (валидация каркаса: {} → 50)', async () => {
    const { queries, journal } = makeQueries();

    const handler = createPrivacyJournalHandler(queries);
    await expect(handler(CHANNEL_SCHEMAS['privacy/journal'].request.parse({}))).resolves.toBe(
      EMPTY_JOURNAL,
    );
    expect(journal).toHaveBeenCalledWith(50);

    await expect(
      handler(CHANNEL_SCHEMAS['privacy/journal'].request.parse({ limit: 7 })),
    ).resolves.toBe(EMPTY_JOURNAL);
    expect(journal).toHaveBeenLastCalledWith(7);
  });

  it('privacy/consents без patch → чтение (getConsents), patch не тронут', async () => {
    const { queries, getConsents, patchConsents } = makeQueries();

    const handler = createPrivacyConsentsHandler(queries);
    await expect(handler({})).resolves.toEqual({ updatesCheck: false, modelsDownload: false });

    expect(getConsents).toHaveBeenCalledTimes(1);
    expect(patchConsents).not.toHaveBeenCalled();
  });

  it('privacy/consents с patch → переключение (patchConsents), ответ — обновлённые согласия', async () => {
    const { queries, patchConsents } = makeQueries();

    const handler = createPrivacyConsentsHandler(queries);
    await expect(handler({ patch: { updatesCheck: true } })).resolves.toEqual({
      updatesCheck: true,
      modelsDownload: false,
    });

    expect(patchConsents).toHaveBeenCalledWith({ updatesCheck: true });
  });

  it('каркас (§11): неизвестный ключ patch → конверт VALIDATION/FAILED ДО хендлера (§5/§14)', async () => {
    const { queries, patchConsents } = makeQueries();
    const registry = createChannelRegistry();
    registry.register(
      'privacy/consents',
      CHANNEL_SCHEMAS['privacy/consents'],
      createPrivacyConsentsHandler(queries),
    );

    const envelope = await registry.dispatch({
      channel: 'privacy/consents',
      payload: { patch: { unknownKey: true } },
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
    }
    expect(patchConsents).not.toHaveBeenCalled();
  });

  it('каркас (§11): невалидный limit (0) → конверт VALIDATION/FAILED ДО хендлера', async () => {
    const { queries, journal } = makeQueries();
    const registry = createChannelRegistry();
    registry.register(
      'privacy/journal',
      CHANNEL_SCHEMAS['privacy/journal'],
      createPrivacyJournalHandler(queries),
    );

    const envelope = await registry.dispatch({ channel: 'privacy/journal', payload: { limit: 0 } });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
    }
    expect(journal).not.toHaveBeenCalled();
  });
});
