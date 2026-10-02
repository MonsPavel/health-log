// TASK-098 §19: юниты PrivacyQueries — агрегация журнала/политики/согласий.
// Гейтвей и согласия — фейковые порты (прецедент updates.test.ts); интеграционный
// путь поверх РЕАЛЬНОГО gateway (журнал после мок-операций 075) — см.
// privacy-queries.int.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type { NetConsents } from '@hl/contracts';

import type { NetworkEventRow } from '../egress/egress-gateway.js';
import { EgressPolicy, type EgressPolicyEntry } from '../egress/egress-policy.js';
import { PrivacyQueries, privacyOperationDescriptionKey } from './privacy-queries.js';

/** Фейковая запись журнала (форма NetworkEventRow gateway, TASK-075 §5). */
const row = (overrides: Partial<NetworkEventRow>): NetworkEventRow => ({
  id: '01TEST',
  kind: 'updates.check',
  endpoint: 'https://releases.example.com/latest',
  status: 'ok',
  bytes: null,
  atUtc: 1_758_816_000_000,
  ...overrides,
});

interface Fixture {
  readonly queries: PrivacyQueries;
  readonly journalSpy: ReturnType<typeof vi.fn<(limit: number) => NetworkEventRow[]>>;
  /** Мутабельные согласия — перечитываются на каждый вызов (§14). */
  consents: NetConsents;
  readonly writeConsents: ReturnType<typeof vi.fn<(consents: NetConsents) => Promise<void>>>;
  /** Queries с другой политикой (§13-инвариант: мок-операция → ops выросла). */
  readonly withPolicy: (policy: Record<string, EgressPolicyEntry>) => PrivacyQueries;
}

const makeFixture = (): Fixture => {
  const journalSpy = vi.fn<(limit: number) => NetworkEventRow[]>(() => []);
  const consents: NetConsents = { updatesCheck: false, modelsDownload: true };
  const writeConsents = vi.fn<(consents: NetConsents) => Promise<void>>(() => Promise.resolve());
  const deps = {
    journal: (limit: number) => journalSpy(limit),
    consents: () => Promise.resolve(consents),
    writeConsents: (value: NetConsents) => writeConsents(value),
  };
  return {
    queries: new PrivacyQueries({ ...deps, policy: { ...EgressPolicy.ALLOWED } }),
    journalSpy,
    consents,
    writeConsents,
    withPolicy: (policy) => new PrivacyQueries({ ...deps, policy }),
  };
};

describe('PrivacyQueries.journal — агрегация (TASK-098 §2/§5)', () => {
  it('entries: лимит проходит в журнал, DTO полон, bytes NULL → отсутствие поля (§5)', async () => {
    const fx = makeFixture();
    fx.journalSpy.mockReturnValue([
      row({ id: '01B', kind: 'models.download', status: 'ok', bytes: 2048, atUtc: 2_000 }),
      row({ id: '01A', kind: 'site.sync', status: 'blocked', bytes: null, atUtc: 1_000 }),
    ]);

    const response = await fx.queries.journal(10);

    expect(fx.journalSpy).toHaveBeenCalledWith(10);
    expect(response.entries).toEqual([
      {
        kind: 'models.download',
        endpoint: 'https://releases.example.com/latest',
        status: 'ok',
        bytes: 2048,
        atUtc: 2_000,
      },
      {
        kind: 'site.sync',
        endpoint: 'https://releases.example.com/latest',
        status: 'blocked',
        atUtc: 1_000, // bytes: null → поле отсутствует (§5 «bytes?»)
      },
    ]);
  });

  it('ops генерируются из ВНЕСЁННОЙ политики: мок-операция → ops выросла (инвариант §13 «нельзя добавить сетевую операцию без UI-описания»)', async () => {
    const fx = makeFixture();
    // Политика РЕАЛЬНОГО приложения: 2 операции.
    expect(Object.keys(EgressPolicy.ALLOWED)).toHaveLength(2);
    const before = await fx.queries.journal(50);
    expect(before.ops).toHaveLength(2);

    // «Добавили сетевую операцию в политику» — тот же класс, ops обязана вырасти
    // САМА (генерация из карты, не ручной список): +1 операция без правок queries.
    const after = await fx
      .withPolicy({
        ...EgressPolicy.ALLOWED,
        'chat.sync': { consentKey: 'modelsDownload' },
      })
      .journal(50);

    expect(after.ops).toHaveLength(3);
    expect(after.ops).toEqual(
      expect.arrayContaining([
        {
          op: 'chat.sync',
          consentKey: 'modelsDownload',
          descriptionKey: 'privacy.ops.chat_sync',
          enabled: true, // enabled — текущее состояние согласия consentKey
        },
      ]),
    );
  });

  it('ops == РЕАЛЬНОЙ политике (инвариант §13/AC): op/consentKey из ALLOWED, descriptionKey детерминирован, enabled из согласий', async () => {
    const fx = makeFixture();

    const { ops } = await fx.queries.journal(50);

    expect(ops).toHaveLength(Object.keys(EgressPolicy.ALLOWED).length);
    for (const [op, entry] of Object.entries(EgressPolicy.ALLOWED)) {
      expect(ops).toContainEqual({
        op,
        consentKey: entry.consentKey,
        descriptionKey: `privacy.ops.${op.replaceAll('.', '_')}`,
        enabled: fx.consents[entry.consentKey],
      });
    }
  });

  it('согласия перечитываются на каждый вызов (§14): отмена согласия меняет enabled следующего ответа', async () => {
    const fx = makeFixture();

    const first = await fx.queries.journal(50);
    expect(first.ops.find((op) => op.op === 'updates.check')?.enabled).toBe(false);

    fx.consents.updatesCheck = true;
    const second = await fx.queries.journal(50);
    expect(second.ops.find((op) => op.op === 'updates.check')?.enabled).toBe(true);
  });
});

describe('PrivacyQueries — согласия (§5/§14)', () => {
  it('getConsents — текущий срез prefs.netConsents', async () => {
    const fx = makeFixture();
    await expect(fx.queries.getConsents()).resolves.toEqual({
      updatesCheck: false,
      modelsDownload: true,
    });
  });

  it('patchConsents: patch известным ключом применяется, остальное сохранено; writeConsents получил ПОЛНЫЙ merged; вернулся merged', async () => {
    const fx = makeFixture();

    const merged = await fx.queries.patchConsents({ updatesCheck: true });

    expect(merged).toEqual({ updatesCheck: true, modelsDownload: true });
    expect(fx.writeConsents).toHaveBeenCalledTimes(1);
    expect(fx.writeConsents).toHaveBeenCalledWith({ updatesCheck: true, modelsDownload: true });
  });

  it('patchConsents: пустой patch — записи нет (лишнего prefs:changed не рождаем), вернулся текущий', async () => {
    const fx = makeFixture();

    const merged = await fx.queries.patchConsents({});

    expect(merged).toEqual({ updatesCheck: false, modelsDownload: true });
    expect(fx.writeConsents).not.toHaveBeenCalled();
  });

  it('patchConsents: defense-in-depth (§14) — только ИЗВЕСТНЫЕ ключи попадают в merged, даже если лишнее просочилось мимо каркаса', async () => {
    const fx = makeFixture();
    const hostile = { updatesCheck: true, unknownKey: 'x' } as unknown as {
      updatesCheck: boolean;
    };

    const merged = await fx.queries.patchConsents(hostile);

    expect(merged).toEqual({ updatesCheck: true, modelsDownload: true });
    expect(fx.writeConsents).toHaveBeenCalledWith({ updatesCheck: true, modelsDownload: true });
  });
});

describe('privacyOperationDescriptionKey (§9: i18n-ключи, без текстов в main)', () => {
  it('детерминированный ключ каталога секции приватности: точки операции → подчёркивания', () => {
    expect(privacyOperationDescriptionKey('models.download')).toBe('privacy.ops.models_download');
    expect(privacyOperationDescriptionKey('updates.check')).toBe('privacy.ops.updates_check');
  });
});
