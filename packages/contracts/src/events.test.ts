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
  type HlEventMap,
  type HlLogLevel,
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

  it('runtime-реестр HL_EVENT_PAYLOAD_KEYS покрывает карту без лишних имён', () => {
    expect(Object.keys(HL_EVENT_PAYLOAD_KEYS).sort()).toEqual(
      ['app:log', 'data:versionBumped', 'measurement:changed'].sort(),
    );
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
