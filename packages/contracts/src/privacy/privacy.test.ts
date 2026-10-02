// TASK-098 §19: тест-контракт каналов экрана «Приватность» — формы §5/§11
// (journal {limit=50} → {entries, ops}, consents {patch?} → Consents),
// strict-гигиена IPC (§14: patch согласий — строгий, неизвестный ключ — отказ) и
// вывод типов из схем (§23, без ручной синхронизации).
import { describe, expect, expectTypeOf, it } from 'vitest';

import { CHANNEL_SCHEMAS } from '../schemas.js';
import {
  NETWORK_EVENT_DTO_SCHEMA,
  PRIVACY_CONSENTS_PATCH_SCHEMA,
  PRIVACY_CONSENTS_REQUEST_SCHEMA,
  PRIVACY_CONSENTS_RESPONSE_SCHEMA,
  PRIVACY_JOURNAL_REQUEST_SCHEMA,
  PRIVACY_JOURNAL_RESPONSE_SCHEMA,
  PRIVACY_OPERATION_SCHEMA,
  type Consents,
  type NetworkEventDto,
  type OperationInfo,
  type PrivacyConsentsRequest,
  type PrivacyJournalRequest,
  type PrivacyJournalResponse,
} from './schemas.js';

describe('privacy/journal — схемы канала (TASK-098 §5/§11)', () => {
  it('запрос: {} → {limit: 50} (дефолт §5); {limit: N} — целое ≥ 1; мусор — отказ (VALIDATION)', () => {
    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.parse({})).toEqual({ limit: 50 });
    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.parse({ limit: 10 })).toEqual({ limit: 10 });

    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.safeParse({ limit: 0 }).success).toBe(false);
    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.safeParse({ limit: -5 }).success).toBe(false);
    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.safeParse({ limit: '50' }).success).toBe(false);
    // strict (§14): лишнее поле запроса — отказ.
    expect(PRIVACY_JOURNAL_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('NetworkEventDto: {kind, endpoint, status, bytes?, atUtc} — bytes опционален (NULL журнала → отсутствие), лишнее поле — отказ', () => {
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({
        kind: 'models.download',
        endpoint: 'https://cdn.example.com/m.bin',
        status: 'ok',
        bytes: 1024,
        atUtc: 1_758_816_000_000,
      }).success,
    ).toBe(true);
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({
        kind: 'site.sync',
        endpoint: 'https://sync.example.com',
        status: 'blocked',
        atUtc: 1_758_816_000_000,
      }).success,
    ).toBe(true);
    // §7: bytes NULL (blocked/failed/без content-length) — не число, отсутствие поля.
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({
        kind: 'x',
        endpoint: 'y',
        status: 'ok',
        bytes: null,
        atUtc: 1,
      }).success,
    ).toBe(false);
    // статусы — домен журнала gateway (TASK-075 §5): running|ok|failed|blocked.
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({
        kind: 'x',
        endpoint: 'y',
        status: 'running',
        atUtc: 1,
      }).success,
    ).toBe(true);
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({
        kind: 'x',
        endpoint: 'y',
        status: 'failed',
        atUtc: 1,
      }).success,
    ).toBe(true);
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({ kind: 'x', endpoint: 'y', status: 'done', atUtc: 1 })
        .success,
    ).toBe(false);
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({ kind: 'x', endpoint: 'y', status: 'ok' }).success,
    ).toBe(false); // atUtc обязателен
    expect(
      NETWORK_EVENT_DTO_SCHEMA.safeParse({
        kind: 'x',
        endpoint: 'y',
        status: 'ok',
        atUtc: 1,
        id: ' лишнее',
      }).success,
    ).toBe(false);
  });

  it('OperationInfo: {op, consentKey, descriptionKey, enabled} — операция политики с ключом согласия и i18n-описанием (§4)', () => {
    expect(
      PRIVACY_OPERATION_SCHEMA.safeParse({
        op: 'updates.check',
        consentKey: 'updatesCheck',
        descriptionKey: 'privacy.ops.updates_check',
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      PRIVACY_OPERATION_SCHEMA.safeParse({
        op: 'updates.check',
        consentKey: 'updatesCheck',
        descriptionKey: 'privacy.ops.updates_check',
      }).success,
    ).toBe(false); // enabled обязателен (§5)
    expect(
      PRIVACY_OPERATION_SCHEMA.safeParse({
        op: 'updates.check',
        consentKey: 'updatesCheck',
        descriptionKey: 'privacy.ops.updates_check',
        enabled: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('ответ: {entries: NetworkEventDto[], ops: OperationInfo[]} — оба массива обязательны (§2)', () => {
    const entry = {
      kind: 'models.download',
      endpoint: 'https://cdn.example.com/m.bin',
      status: 'ok',
      atUtc: 1_758_816_000_000,
    };
    const op = {
      op: 'updates.check',
      consentKey: 'updatesCheck',
      descriptionKey: 'privacy.ops.updates_check',
      enabled: true,
    };
    expect(PRIVACY_JOURNAL_RESPONSE_SCHEMA.safeParse({ entries: [entry], ops: [op] }).success).toBe(
      true,
    );
    expect(PRIVACY_JOURNAL_RESPONSE_SCHEMA.safeParse({ entries: [], ops: [] }).success).toBe(true);
    expect(PRIVACY_JOURNAL_RESPONSE_SCHEMA.safeParse({ entries: [entry] }).success).toBe(false);
    expect(PRIVACY_JOURNAL_RESPONSE_SCHEMA.safeParse({ ops: [op] }).success).toBe(false);
    expect(PRIVACY_JOURNAL_RESPONSE_SCHEMA.safeParse({ entries: [], ops: [], extra: 1 }).success).toBe(
      false,
    );
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<PrivacyJournalRequest>().toEqualTypeOf<{ limit: number }>();
    expectTypeOf<NetworkEventDto>().toEqualTypeOf<{
      kind: string;
      endpoint: string;
      status: 'running' | 'ok' | 'failed' | 'blocked';
      bytes?: number;
      atUtc: number;
    }>();
    expectTypeOf<OperationInfo>().toEqualTypeOf<{
      op: string;
      consentKey: string;
      descriptionKey: string;
      enabled: boolean;
    }>();
    expectTypeOf<PrivacyJournalResponse>().toEqualTypeOf<{
      entries: NetworkEventDto[];
      ops: OperationInfo[];
    }>();
  });

  it('CHANNEL_SCHEMAS содержит privacy/journal — secure (журнал network_event в БД, §8)', () => {
    const schemas = CHANNEL_SCHEMAS['privacy/journal'];
    expect(schemas).toBeDefined();
    expect(schemas?.secure).toBe(true);
  });
});

describe('privacy/consents — схемы канала (TASK-098 §5/§11/§14)', () => {
  it('запрос: {} — чтение; {patch: Partial<Consents>} — переключение; patch опционален', () => {
    expect(PRIVACY_CONSENTS_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(PRIVACY_CONSENTS_REQUEST_SCHEMA.safeParse({ patch: {} }).success).toBe(true);
    expect(PRIVACY_CONSENTS_REQUEST_SCHEMA.safeParse({ patch: { updatesCheck: true } }).success).toBe(
      true,
    );
    expect(
      PRIVACY_CONSENTS_REQUEST_SCHEMA.safeParse({
        patch: { updatesCheck: false, modelsDownload: true },
      }).success,
    ).toBe(true);
    // strict верхнего уровня (§14).
    expect(PRIVACY_CONSENTS_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
    expect(PRIVACY_CONSENTS_REQUEST_SCHEMA.safeParse({ patch: null }).success).toBe(false);
  });

  it('patch строгий (§14): неизвестный ключ — отказ (VALIDATION каркаса), неверный тип — отказ', () => {
    expect(PRIVACY_CONSENTS_PATCH_SCHEMA.safeParse({ unknown: true }).success).toBe(false);
    expect(PRIVACY_CONSENTS_PATCH_SCHEMA.safeParse({ updatesCheck: 'yes' }).success).toBe(false);
    expect(PRIVACY_CONSENTS_PATCH_SCHEMA.safeParse({ updatesCheck: 1 }).success).toBe(false);
  });

  it('ответ Consents: {updatesCheck, modelsDownload} — оба boolean (форма netConsents prefs, §23 переиспользование)', () => {
    expect(PRIVACY_CONSENTS_RESPONSE_SCHEMA.safeParse({ updatesCheck: true, modelsDownload: false }).success).toBe(
      true,
    );
    expect(PRIVACY_CONSENTS_RESPONSE_SCHEMA.safeParse({ updatesCheck: true }).success).toBe(false);
    expect(
      PRIVACY_CONSENTS_RESPONSE_SCHEMA.safeParse({
        updatesCheck: true,
        modelsDownload: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<Consents>().toEqualTypeOf<{ updatesCheck: boolean; modelsDownload: boolean }>();
    expectTypeOf<PrivacyConsentsRequest>().toEqualTypeOf<{
      patch?: { updatesCheck?: boolean; modelsDownload?: boolean };
    }>();
  });

  it('CHANNEL_SCHEMAS содержит privacy/consents — secure (prefs в app_setting БД, §14)', () => {
    const schemas = CHANNEL_SCHEMAS['privacy/consents'];
    expect(schemas).toBeDefined();
    expect(schemas?.secure).toBe(true);
  });
});
