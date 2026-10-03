// TASK-008 §5/§19: транспортный контракт моста — типы ChannelName/HlBridge и схема
// запроса к единой точке диспетчеризации main (§13: порядок проверок начинается с
// «канал существует?»; у Electron нет hook на invoke незарегистрированного канала,
// поэтому неизвестный канал обнаруживает каркас — §11/§20).
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  HL_INVOKE_CHANNEL,
  HL_INVOKE_REQUEST_SCHEMA,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type HlBridge,
} from './channels.js';
import { CHANNEL_SCHEMAS } from './schemas.js';

describe('HL_INVOKE_CHANNEL — транспортный канал main (единая точка)', () => {
  it('имя в неймспейсе hl, не пересекается с прикладными каналами (домен/действие)', () => {
    expect(HL_INVOKE_CHANNEL).toBe('hl:invoke');
  });
});

describe('HL_INVOKE_REQUEST_SCHEMA — форма запроса моста', () => {
  it('принимает {channel, payload}', () => {
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ channel: 'app/ping', payload: {} }).success).toBe(
      true,
    );
  });

  it('отклоняет запрос без channel или без payload', () => {
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ channel: 'app/ping' }).success).toBe(false);
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ payload: {} }).success).toBe(false);
  });

  it('отклоняет не-строковый channel и не-объектный запрос', () => {
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse({ channel: 42, payload: {} }).success).toBe(false);
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse('invoke').success).toBe(false);
    expect(HL_INVOKE_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
  });
});

describe('типы реестра — компилятор выводит payload/ответ из схем (§23: без ручной синхронизации)', () => {
  it('ChannelName — строковый union прикладных каналов (TASK-011: app/log-client-error; TASK-028: + 4 канала измерений; TASK-045: notes/search; TASK-051: scales/active; TASK-054: stats/period; TASK-056: trend/series; TASK-070: backup/create; TASK-071/072: backup/restore, data/wipe; TASK-062: __bench/seed; TASK-065: report/export-*; TASK-068: report/pdf, app/reveal-path; TASK-073: file/open-dialog; TASK-081: ai/models/*; TASK-083: ai/context/preview; TASK-087/088: ai/summary/*, ai/cancel; TASK-089: ai/chat/*; TASK-094: vault/*; TASK-095: app/heartbeat; TASK-098: privacy/*; TASK-100: app/selfcheck|meta|integrity-full; TASK-102: __test/*)', () => {
    expectTypeOf<ChannelName>().toEqualTypeOf<
      | '__bench/seed'
      // TASK-102 §5/§11: TEST-ONLY крэш-тест NFR-3 — батч-вставка + снимок состояния БД.
      | '__test/insert-batch'
      | '__test/db-state'
      | 'ai/models/list'
      | 'ai/models/download'
      | 'ai/models/pause'
      | 'ai/models/resume'
      | 'ai/models/reset'
      | 'ai/models/select'
      | 'ai/context/preview'
      | 'ai/summary/generate'
      | 'ai/summary/latest'
      | 'ai/summary/delete-all'
      | 'ai/chat/send'
      | 'ai/chat/clear'
      | 'ai/chat/list'
      | 'ai/cancel'
      | 'app/ping'
      | 'app/log-client-error'
      | 'app/reveal-path'
      | 'app/heartbeat'
      // TASK-100 §5/§11: сампроверка старта, версии «О приложении», полная проверка.
      | 'app/selfcheck'
      | 'app/meta'
      | 'app/integrity-full'
      // TASK-101 §5/§9: «Открыть папку с копиями» recovery-экрана (путь строит main).
      | 'app/reveal-backups'
      // TASK-113 §5/§8–12: «Помощь» настроек — открыть страницу руководства docs/user.
      | 'app/open-docs'
      | 'backup/create'
      | 'backup/restore'
      // TASK-101 §5/§9: «начать заново» — wipe-подмножество (unlink db/-wal/-shm).
      | 'data/discard-db'
      | 'data/wipe'
      // TASK-103 §5/§11: диагностический пакет — предпросмотр содержимого и
      // сохранение zip за save-диалогом main.
      | 'diag/preview'
      | 'diag/save'
      | 'file/open-dialog'
      | 'measurements/add'
      | 'measurements/list'
      | 'measurements/update'
      | 'measurements/delete'
      | 'notes/search'
      | 'prefs/get'
      | 'prefs/set'
      | 'privacy/journal'
      | 'privacy/consents'
      | 'report/export-csv'
      | 'report/export-json'
      | 'report/pdf'
      | 'scales/active'
      | 'stats/period'
      | 'trend/series'
      | 'updates/check'
      | 'updates/download'
      | 'updates/install'
      | 'vault/lock'
      | 'vault/set-passphrase'
      | 'vault/status'
      | 'vault/unlock'
    >();
  });

  it('ChannelRequest для app/ping — вывод z.infer из схемы запроса', () => {
    // Пустой запрос z.object({}) — type-литералы на {} бьют в известный крэш
    // перегрузки expectTypeOf («Expected 1 arguments»); форму фиксирует сама
    // strict-схема: пусто — ок, лишнее поле — нет.
    const schema = CHANNEL_SCHEMAS['app/ping']?.request;
    expect(schema?.safeParse({}).success).toBe(true);
    expect(schema?.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('ChannelResponse для app/ping — {pong: true, ts: number}', () => {
    expectTypeOf<ChannelResponse<'app/ping'>>().toEqualTypeOf<{ pong: true; ts: number }>();
  });

  it('HlBridge.invoke требует известный ChannelName — «дозвониться» до чужого канала нельзя (арх. 05 §1)', () => {
    expectTypeOf<HlBridge['invoke']>().parameter(0).toEqualTypeOf<ChannelName>();
    expectTypeOf<HlBridge['invoke']>().returns.toEqualTypeOf<Promise<unknown>>();
    // Не выполняется (только тип-проверка): неизвестный канал — ошибка компиляции.
    const callUnknownChannel = (bridge: HlBridge): Promise<unknown> =>
      // @ts-expect-error ChannelName не содержит app/nope — рантайм-реестр в рендерере не нужен
      bridge.invoke('app/nope', {});
    expectTypeOf(callUnknownChannel).returns.toEqualTypeOf<Promise<unknown>>();
  });

  it('ChannelRequest/ChannelResponse для app/log-client-error выводятся из схем (TASK-011 §7/§11)', () => {
    expectTypeOf<ChannelRequest<'app/log-client-error'>>().toEqualTypeOf<{
      code: 'APP/RENDERER';
      messageKey: string;
      digest: string;
    }>();
    expectTypeOf<ChannelResponse<'app/log-client-error'>>().toEqualTypeOf<null>();
  });
});
