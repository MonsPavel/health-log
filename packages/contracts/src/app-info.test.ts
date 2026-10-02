// TASK-100 §5/§11/§19: контракты сампроверки старта и «О приложении».
//  - SelfCheckReport — иммутабельный снимок старта {dbOk, schemaVersion, vaultMode,
//    worker?, prefsOk, checkedAtUtc, startupMs} (§5); без путей/PHI (§14 — инвариант
//    полей ниже);
//  - app/selfcheck {} → SelfCheckReport | null (null — самчек ещё не выполнялся,
//    например старт в locked до unlock); НЕ secure — отчёт из памяти main (§11);
//  - app/meta {} → {appVersion, schemaVersion, scale, model?} — строки версий UI
//    (приложение/схема БД/активная шкала code+version/модель id+version если есть);
//    НЕ secure — канал режима/версий, в recovery-режиме TASK-101 §9 остаётся
//    доступным (задокументировано в инвентаре vault.test.ts);
//  - app/integrity-full {} → {ok, details} — полная проверка (PRAGMA integrity_check)
//    по кнопке (§4/§11); secure — БД-канал (§7 TASK-094).
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ChannelName, ChannelRequest, ChannelResponse } from './channels.js';
import { CHANNEL_SCHEMAS } from './schemas.js';
import {
  APP_INTEGRITY_FULL_REQUEST_SCHEMA,
  APP_INTEGRITY_FULL_RESPONSE_SCHEMA,
  APP_META_REQUEST_SCHEMA,
  APP_META_RESPONSE_SCHEMA,
  APP_SELFCHECK_REQUEST_SCHEMA,
  APP_SELFCHECK_RESPONSE_SCHEMA,
  SELF_CHECK_REPORT_SCHEMA,
} from './app-info.js';

/** Валидный отчёт сампроверки (healthy-старт, §19). */
const HEALTHY_REPORT = {
  dbOk: true,
  schemaVersion: 9,
  vaultMode: 'none',
  worker: { state: 'ready' },
  prefsOk: true,
  checkedAtUtc: 1_758_816_000_000,
  startupMs: 12,
} as const;

describe('SelfCheckReport — форма снимка старта (TASK-100 §5)', () => {
  it('healthy-отчёт валиден: все поля §5 присутствуют', () => {
    const parsed = SELF_CHECK_REPORT_SCHEMA.safeParse(HEALTHY_REPORT);
    expect(parsed.success).toBe(true);
  });

  it('worker опционален (§5 «если ИИ-модуль есть»), остальные поля обязательны', () => {
    const { worker: _worker, ...withoutWorker } = HEALTHY_REPORT;
    expect(SELF_CHECK_REPORT_SCHEMA.safeParse(withoutWorker).success).toBe(true);
    const { dbOk: _dbOk, ...withoutDbOk } = HEALTHY_REPORT;
    expect(SELF_CHECK_REPORT_SCHEMA.safeParse(withoutDbOk).success).toBe(false);
  });

  it('strict: неизвестное поле отклонено — инвариант «без путей/PHI» (§14, AC5)', () => {
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, dbPath: 'C:\\Users\\me\\db' })
        .success,
    ).toBe(false);
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, notes: 'текст пользователя' })
        .success,
    ).toBe(false);
  });

  it('vaultMode — enum none|passphrase; worker.state — статусы AiWorkerState', () => {
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, vaultMode: 'keyfile' }).success,
    ).toBe(false);
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, worker: { state: 'nope' } }).success,
    ).toBe(false);
    for (const state of ['starting', 'ready', 'busy', 'restarting', 'failed'] as const) {
      expect(
        SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, worker: { state } }).success,
      ).toBe(true);
    }
  });

  it('числа целые неотрицательные: checkedAtUtc (мс эпохи), startupMs, schemaVersion', () => {
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, startupMs: -1 }).success,
    ).toBe(false);
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, checkedAtUtc: 1.5 }).success,
    ).toBe(false);
    expect(
      SELF_CHECK_REPORT_SCHEMA.safeParse({ ...HEALTHY_REPORT, schemaVersion: -1 }).success,
    ).toBe(false);
  });
});

describe('канал app/selfcheck (TASK-100 §11)', () => {
  it('запрос {} strict — без параметров (§14)', () => {
    expect(APP_SELFCHECK_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(APP_SELFCHECK_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('ответ — SelfCheckReport | null (null — самчек ещё не выполнялся, locked-старт)', () => {
    expect(APP_SELFCHECK_RESPONSE_SCHEMA.safeParse(HEALTHY_REPORT).success).toBe(true);
    expect(APP_SELFCHECK_RESPONSE_SCHEMA.safeParse(null).success).toBe(true);
    expect(APP_SELFCHECK_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('канал в реестре и НЕ secure — отчёт из памяти main, БД не читает (§11)', () => {
    expect(Object.keys(CHANNEL_SCHEMAS)).toContain('app/selfcheck');
    expect((CHANNEL_SCHEMAS['app/selfcheck'] as { secure?: boolean }).secure).not.toBe(true);
  });

  it('типы запроса/ответа выведены из реестра схем (§23)', () => {
    expectTypeOf<ChannelRequest<'app/selfcheck'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<ChannelResponse<'app/selfcheck'>>().toEqualTypeOf<
      | {
          dbOk: boolean;
          schemaVersion: number;
          vaultMode: 'none' | 'passphrase';
          worker?: { state: 'starting' | 'ready' | 'busy' | 'restarting' | 'failed' };
          prefsOk: boolean;
          checkedAtUtc: number;
          startupMs: number;
        }
      | null
    >();
  });
});

describe('канал app/meta — версии для «О приложении» (TASK-100 §5/§11)', () => {
  const META = {
    appVersion: '0.1.0',
    schemaVersion: 9,
    scale: { code: 'BP-OFFICE-ESC2018', version: '1.0.0' },
    model: { id: 'qwen3-4b', version: '1.0' },
  } as const;

  it('полная форма валидна: приложение/схема/шкала code+version/модель id+version', () => {
    expect(APP_META_RESPONSE_SCHEMA.safeParse(META).success).toBe(true);
  });

  it('model опционален («модель id+version если есть»), остальные поля обязательны', () => {
    const { model: _model, ...withoutModel } = META;
    expect(APP_META_RESPONSE_SCHEMA.safeParse(withoutModel).success).toBe(true);
    const { scale: _scale, ...withoutScale } = META;
    expect(APP_META_RESPONSE_SCHEMA.safeParse(withoutScale).success).toBe(false);
  });

  it('strict: лишние поля (путь/PHI) отклонены (§14)', () => {
    expect(APP_META_RESPONSE_SCHEMA.safeParse({ ...META, dbPath: '/x/y' }).success).toBe(false);
  });

  it('запрос {} strict; канал в реестре; НЕ secure (канал версий/режима — TASK-101 §9)', () => {
    expect(APP_META_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(Object.keys(CHANNEL_SCHEMAS)).toContain('app/meta');
    expect((CHANNEL_SCHEMAS['app/meta'] as { secure?: boolean }).secure).not.toBe(true);
  });
});

describe('канал app/integrity-full — полная проверка БД (TASK-100 §4/§11)', () => {
  it('запрос {} strict (§14)', () => {
    expect(APP_INTEGRITY_FULL_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(APP_INTEGRITY_FULL_REQUEST_SCHEMA.safeParse({ mode: 'x' }).success).toBe(false);
  });

  it('ответ {ok, details} — результат PRAGMA integrity_check (details — текст вывода)', () => {
    expect(APP_INTEGRITY_FULL_RESPONSE_SCHEMA.safeParse({ ok: true, details: 'ok' }).success).toBe(
      true,
    );
    expect(
      APP_INTEGRITY_FULL_RESPONSE_SCHEMA.safeParse({
        ok: false,
        details: '*** in database main: On tree page 3: invalid page type',
      }).success,
    ).toBe(true);
    expect(APP_INTEGRITY_FULL_RESPONSE_SCHEMA.safeParse({ ok: true }).success).toBe(false);
  });

  it('канал в реестре и secure — БД-канал (гвардия requireUnlocked, §7 TASK-094)', () => {
    expect(Object.keys(CHANNEL_SCHEMAS)).toContain('app/integrity-full');
    expect((CHANNEL_SCHEMAS['app/integrity-full'] as { secure?: boolean }).secure).toBe(true);
  });

  it('имена каналов входят в union ChannelName (компилятор не даст забыть)', () => {
    const selfcheck: ChannelName = 'app/selfcheck';
    const meta: ChannelName = 'app/meta';
    const integrity: ChannelName = 'app/integrity-full';
    expect(selfcheck + meta + integrity).toBe(
      'app/selfcheckapp/metaapp/integrity-full',
    );
  });
});
