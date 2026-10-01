// TASK-096 §19: тест-контракт каналов обновлений updates/* — формы §5/§11
// (check → {status, version?}, download → тот же статус, install → {restarting}),
// strict-гигиена IPC (§14) и вывод типов из схем (§23, без ручной синхронизации).
import { describe, expect, expectTypeOf, it } from 'vitest';

import { CHANNEL_SCHEMAS } from './schemas.js';
import {
  UPDATES_CHECK_REQUEST_SCHEMA,
  UPDATES_DOWNLOAD_REQUEST_SCHEMA,
  UPDATES_INSTALL_REQUEST_SCHEMA,
  UPDATES_INSTALL_RESPONSE_SCHEMA,
  UPDATES_STATUS_RESPONSE_SCHEMA,
  type UpdatesInstallResponse,
  type UpdatesStatusResponse,
} from './updates.js';

describe('updates/* — схемы каналов (TASK-096 §5/§11)', () => {
  it('updates/check: запрос {} (strict — лишнее поле отклонено), ответ {status, version?}', () => {
    expect(UPDATES_CHECK_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(UPDATES_CHECK_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);

    expect(
      UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'available', version: '1.2.3' }).success,
    ).toBe(true);
    expect(UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'latest' }).success).toBe(true);
    expect(UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'ready' }).success).toBe(true);
    expect(UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'error' }).success).toBe(true);
    // неизвестный статус, лишнее поле, пустая версия — отказ (strict, §14)
    expect(UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'checking' }).success).toBe(false);
    expect(UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'latest', extra: 1 }).success).toBe(
      false,
    );
    expect(
      UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'available', version: '' }).success,
    ).toBe(false);
  });

  it('updates/download: запрос {} — загрузка покрывается согласием updatesCheck (§5 РЕШЕНИЕ); ответ — та же форма статуса (§23: одна схема, прецедент report/export-*)', () => {
    expect(UPDATES_DOWNLOAD_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(UPDATES_DOWNLOAD_REQUEST_SCHEMA.safeParse({ modelId: 'x' }).success).toBe(false);
    expect(UPDATES_STATUS_RESPONSE_SCHEMA.safeParse({ status: 'ready', version: '2.0.0' }).success).toBe(
      true,
    );
  });

  it('updates/install: запрос {}; ответ {restarting: true} — literal (§5: приложение уходит в перезапуск)', () => {
    expect(UPDATES_INSTALL_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(UPDATES_INSTALL_RESPONSE_SCHEMA.safeParse({ restarting: true }).success).toBe(true);
    expect(UPDATES_INSTALL_RESPONSE_SCHEMA.safeParse({ restarting: false }).success).toBe(false);
  });

  it('CHANNEL_SCHEMAS содержит три канала updates/* (реестр — компилятор не даст забыть, §5)', () => {
    expect(CHANNEL_SCHEMAS['updates/check']).toBeDefined();
    expect(CHANNEL_SCHEMAS['updates/download']).toBeDefined();
    expect(CHANNEL_SCHEMAS['updates/install']).toBeDefined();
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<UpdatesStatusResponse>().toEqualTypeOf<{
      status: 'available' | 'latest' | 'ready' | 'error';
      version?: string;
    }>();
    expectTypeOf<UpdatesInstallResponse>().toEqualTypeOf<{ restarting: true }>();
  });
});
