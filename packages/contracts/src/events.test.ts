/**
 * TASK-009 §19/§20: тест-контракт карты событий.
 *
 * Два уровня проверки:
 *  1. Состав и типы HlEventMap (§5/§20): имена зафиксированы сейчас, публикуются
 *     позже (TASK-026) — карта и есть контракт между main и рендерером.
 *  2. Payload-контракт PHI (§14/§20): ни один payload карты не содержит полей
 *     измерений/заметок — события только сигналы (версии, id, статусы).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  HL_EVENT_CHANNEL,
  HL_EVENT_PAYLOAD_KEYS,
  type AiWorkerState,
  type HlEventMap,
  type HlLogLevel,
  type ModelStatus,
} from './events.js';

describe('HlEventMap — начальный состав (§5, §20)', () => {
  it('содержит data:versionBumped с payload {newVersion: number}', () => {
    expectTypeOf<HlEventMap['data:versionBumped']>().toEqualTypeOf<{
      readonly newVersion: number;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['data:versionBumped']).toEqual(['newVersion']);
  });

  it('содержит measurement:changed с payload {profileId: string}', () => {
    expectTypeOf<HlEventMap['measurement:changed']>().toEqualTypeOf<{
      readonly profileId: string;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['measurement:changed']).toEqual(['profileId']);
  });

  it('содержит app:log с payload {level, messageKey} — только ключ сообщения, без текстов (§17)', () => {
    expectTypeOf<HlEventMap['app:log']>().toEqualTypeOf<{
      readonly level: HlLogLevel;
      readonly messageKey: string;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['app:log']).toEqual(['level', 'messageKey']);
  });

  it('содержит prefs:changed с payload {patchKeys} — имена изменённых ключей, не значения (TASK-047 §5/§7)', () => {
    expectTypeOf<HlEventMap['prefs:changed']>().toEqualTypeOf<{
      readonly patchKeys: readonly string[];
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['prefs:changed']).toEqual(['patchKeys']);
  });

  it('содержит job:backup-reminder с ПУСТЫМ payload — сигнал баннера о копии (TASK-074 §5/§11)', () => {
    expectTypeOf<HlEventMap['job:backup-reminder']>().toEqualTypeOf<Record<string, never>>();
    expect(HL_EVENT_PAYLOAD_KEYS['job:backup-reminder']).toEqual([]);
  });

  it('содержит net:activity с payload {kind, endpoint} — только метаданные, без PHI (TASK-075 §5/§11/§7)', () => {
    expectTypeOf<HlEventMap['net:activity']>().toEqualTypeOf<{
      readonly kind: string;
      readonly endpoint: string;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['net:activity']).toEqual(['kind', 'endpoint']);
  });

  it('содержит ai:status с payload {state, requestId?} — статусы воркера §7 TASK-076', () => {
    expectTypeOf<HlEventMap['ai:status']>().toEqualTypeOf<{
      readonly state: AiWorkerState;
      readonly requestId?: string;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['ai:status']).toEqual(['state', 'requestId']);
  });

  it('содержит ai:token с payload {requestId, text} — БАТЧ токенов (flush 50 мс, TASK-076 §11)', () => {
    expectTypeOf<HlEventMap['ai:token']>().toEqualTypeOf<{
      readonly requestId: string;
      readonly text: string;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['ai:token']).toEqual(['requestId', 'text']);
  });

  it('runtime-реестр HL_EVENT_PAYLOAD_KEYS покрывает карту без лишних имён', () => {
    expect(Object.keys(HL_EVENT_PAYLOAD_KEYS).sort()).toEqual(
      [
        'ai:progress',
        'ai:status',
        'ai:token',
        'ai/chat/result',
        'ai/summary/result',
        'app:log',
        'data:versionBumped',
        'job:backup-reminder',
        'measurement:changed',
        'net:activity',
        'prefs:changed',
      ].sort(),
    );
  });

  it('содержит ai/chat/result с payload {requestId, messageId?} — финал хода чата (TASK-089 §11)', () => {
    expectTypeOf<HlEventMap['ai/chat/result']>().toEqualTypeOf<{
      readonly requestId: string;
      readonly messageId?: string;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['ai/chat/result']).toEqual(['requestId', 'messageId']);
  });

  it('содержит ai/summary/result с payload {requestId, summaryId?, cached, stale} — финал резюме (TASK-087 §11)', () => {
    expectTypeOf<HlEventMap['ai/summary/result']>().toEqualTypeOf<{
      readonly requestId: string;
      readonly summaryId?: string;
      readonly cached: boolean;
      readonly stale: boolean;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['ai/summary/result']).toEqual([
      'requestId',
      'summaryId',
      'cached',
      'stale',
    ]);
  });

  it('содержит ai:progress с payload {modelId, downloadedBytes, totalBytes, state} — прогресс загрузки модели (TASK-080 §11)', () => {
    expectTypeOf<HlEventMap['ai:progress']>().toEqualTypeOf<{
      readonly modelId: string;
      readonly downloadedBytes: number;
      readonly totalBytes: number;
      readonly state: ModelStatus;
    }>();
    expect(HL_EVENT_PAYLOAD_KEYS['ai:progress']).toEqual([
      'modelId',
      'downloadedBytes',
      'totalBytes',
      'state',
    ]);
  });
});

describe('Payload-контракт PHI (§14, §20)', () => {
  it('нет полей sys/dia/pulse/note/content ни в одном payload карты', () => {
    const forbidden = new Set(['sys', 'dia', 'pulse', 'note', 'content']);
    const payloadFields = Object.values(HL_EVENT_PAYLOAD_KEYS).flat();
    expect(payloadFields.filter((field) => forbidden.has(field))).toEqual([]);
  });
});

describe('Транспортный канал событий (§5/§11)', () => {
  it('единый канал hl:event', () => {
    expect(HL_EVENT_CHANNEL).toBe('hl:event');
  });
});
