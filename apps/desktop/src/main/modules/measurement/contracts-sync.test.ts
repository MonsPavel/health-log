// TASK-028 §19/§22: синхронизационный контракт-тест «домен ↔ zod-схема».
//
// Границы домена продублированы в схемах контракта осознанно (§4: renderer не
// импортирует main-домен; числа — measurement/schemas.ts с комментарием-ссылкой на
// domain/constants.ts). Этот тест — сеть ловли дрейфа: одно и то же подмножество
// случаев прогоняется и через zod-схему канала measurements/add (реестр
// CHANNEL_SCHEMAS), и через доменные фабрики TASK-016/017 (BloodPressure, Pulse,
// BpMeasurement.create) — вердикты должны совпадать. Расхождение = сломанный
// инвариант (см. пункт §22: «обязателен к прогону при любом изменении границ»).
//
// Вердикты сравниваются только на подмножестве: arm в домене проверяется компилятором
// (тип Arm, arm.ts §7 — runtime-фабрики нет), а «не будущее» время и trim заметки —
// осознанные расхождения, зафиксированные ниже как документация (§13).
import { describe, expect, it } from 'vitest';

import { CHANNEL_SCHEMAS, type MeasurementAddRequest } from '@hl/contracts';
import { FixedClock } from '@hl/kernel';

import { BpMeasurement } from './domain/bp-measurement.js';
import { BloodPressure } from './domain/blood-pressure.js';
import { Pulse } from './domain/pulse.js';
import type { CreateMeasurementCommand } from './domain/measurement-commands.js';

/** Фиксированное «сейчас» — синхронно с доменными тестами TASK-017 (FixedClock, NFR-10). */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

const ADD_REQUEST = CHANNEL_SCHEMAS['measurements/add'].request;

/** Базовый валидный payload: takenAt за минуту до «сейчас» (в прошлом). */
const BASE: MeasurementAddRequest = {
  profileId: 'seed-profile-0001',
  sys: 120,
  dia: 80,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  note: 'после пробежки',
  takenAt: { utcMs: NOW_MS - 60_000, tzOffsetMin: TZ },
};

/** Вердикт zod-схемы канала add (тот же payload, что в домен — §19). */
const schemaOk = (payload: MeasurementAddRequest): boolean => ADD_REQUEST.safeParse(payload).success;

/** Вердикт агрегата: полный инвариант (BloodPressure → Pulse → note → время). */
const aggregateOk = (payload: MeasurementAddRequest): boolean =>
  BpMeasurement.create(payload as CreateMeasurementCommand, new FixedClock(NOW_MS, TZ)).ok;

/** Вердикт VO давления — для точечных кейсов границ sys/dia. */
const bpOk = (sys: number, dia: number): boolean => BloodPressure.create(sys, dia).ok;

/** Вердикт VO пульса. */
const pulseOk = (value: number | undefined): boolean => Pulse.create(value).ok;

describe('синхронизация домен ↔ схема: валидные payload — оба принимают (§19)', () => {
  it('полный валидный payload', () => {
    expect(schemaOk(BASE)).toBe(true);
    expect(aggregateOk(BASE)).toBe(true);
  });

  it('опциональные pulse/note отсутствуют — оба принимают (FR-1.1)', () => {
    const { pulse: _p, note: _n, ...minimal } = BASE;
    expect(schemaOk(minimal)).toBe(true);
    expect(aggregateOk(minimal)).toBe(true);
  });

  it('границы 50/20/20 и 300/200/300 (sys>dia выполнен) — оба принимают (SRS FR-1.2)', () => {
    const low = { ...BASE, sys: 50, dia: 20, pulse: 20 };
    const high = { ...BASE, sys: 300, dia: 200, pulse: 300 };
    for (const payload of [low, high]) {
      expect(schemaOk(payload)).toBe(true);
      expect(aggregateOk(payload)).toBe(true);
    }
    expect(bpOk(50, 20)).toBe(true);
    expect(bpOk(300, 200)).toBe(true);
    expect(pulseOk(20)).toBe(true);
    expect(pulseOk(300)).toBe(true);
    expect(pulseOk(undefined)).toBe(true);
  });

  it('заметка ровно 500 символов — оба принимают (§13: 500 ок)', () => {
    const payload = { ...BASE, note: 'а'.repeat(500) };
    expect(schemaOk(payload)).toBe(true);
    expect(aggregateOk(payload)).toBe(true);
  });

  it('takenAt ровно «сейчас» — оба принимают (равенство валидно, §13 TASK-017)', () => {
    const payload = { ...BASE, takenAt: { utcMs: NOW_MS, tzOffsetMin: TZ } };
    expect(schemaOk(payload)).toBe(true);
    expect(aggregateOk(payload)).toBe(true);
  });
});

describe('синхронизация домен ↔ схема: нарушения — оба отвергают (§19: ловит дрейф чисел)', () => {
  const bothReject = (payload: MeasurementAddRequest): void => {
    expect(schemaOk(payload)).toBe(false);
    expect(aggregateOk(payload)).toBe(false);
  };

  it('СДА вне [50, 300]: 49 и 301 — оба отвергают', () => {
    bothReject({ ...BASE, sys: 49 });
    bothReject({ ...BASE, sys: 301 });
    expect(bpOk(49, 80)).toBe(false);
    expect(bpOk(301, 80)).toBe(false);
  });

  it('ДДА вне [20, 200]: 19 и 201 — оба отвергают', () => {
    bothReject({ ...BASE, dia: 19 });
    // dia 201: и диапазон ДДА нарушен, и sys≤dia — отвергают оба слоя.
    bothReject({ ...BASE, sys: 300, dia: 201 });
    expect(bpOk(120, 19)).toBe(false);
  });

  it('нецелые sys/dia/pulse — оба отвергают (порядок домена §7: «целые → диапазоны»)', () => {
    bothReject({ ...BASE, sys: 120.5 });
    bothReject({ ...BASE, dia: 80.5 });
    bothReject({ ...BASE, pulse: 70.5 });
    expect(bpOk(120.5, 80)).toBe(false);
    expect(pulseOk(70.5)).toBe(false);
  });

  it('sys ≤ dia — оба отвергают (инвариант VO BloodPressure, TASK-016)', () => {
    bothReject({ ...BASE, sys: 120, dia: 120 });
    bothReject({ ...BASE, sys: 80, dia: 120 });
    expect(bpOk(120, 120)).toBe(false);
    expect(bpOk(80, 120)).toBe(false);
  });

  it('ЧСС вне [20, 300]: 19 и 301 — оба отвергают', () => {
    bothReject({ ...BASE, pulse: 19 });
    bothReject({ ...BASE, pulse: 301 });
    expect(pulseOk(19)).toBe(false);
    expect(pulseOk(301)).toBe(false);
  });

  it('заметка 501 символ (без whitespace) — оба отвергают (NOTE_TOO_LONG, §13)', () => {
    bothReject({ ...BASE, note: 'а'.repeat(501) });
  });
});

describe('осознанные расхождения — зафиксированы как документация (§13)', () => {
  it('«не будущее» время: схема пропускает, домен отвергает — вердикт домена (нужен Clock)', () => {
    const future = { ...BASE, takenAt: { utcMs: NOW_MS + 3_600_000, tzOffsetMin: TZ } };
    expect(schemaOk(future)).toBe(true);
    const result = BpMeasurement.create(future as CreateMeasurementCommand, new FixedClock(NOW_MS, TZ));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MEASUREMENT/FUTURE_TIME');
    }
  });

  it('заметка 501 символ с хвостовым whitespace: схема строже (проверяет ДО trim) — домен принимает', () => {
    const payload = { ...BASE, note: `а${' '.repeat(500)}` };
    expect(schemaOk(payload)).toBe(false);
    expect(aggregateOk(payload)).toBe(true);
  });

  it('arm: домен не имеет runtime-фабрики (тип Arm, компилятор) — схему сравнить не с чем (arm.ts §7)', () => {
    // Схема — единственный runtime-барьер для arm; вердикт-сравнение на arm неприменимо.
    expect(ADD_REQUEST.safeParse({ ...BASE, arm: 'center' }).success).toBe(false);
  });
});
