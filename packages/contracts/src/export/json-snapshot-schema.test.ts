/**
 * TASK-064 §19/§20: контракт-тесты zod-схемы JSON-слепка (мастер-формат, публичный
 * контракт — экспорт обязан проходить валидацию собственной схемой, §4).
 *
 * Матрица:
 *  - валидный минимальный слепок разбирается (пустые массивы, без prefs — §13);
 *  - полная форма разбирается: MeasurementDto (переиспользование TASK-028, §7),
 *    профиль {id, name, createdAtUtc}, prefs = Prefs (TASK-047), шкала {code, version};
 *  - prefs опционально (не настроены → ключ отсутствует, §13); null отвергается;
 *  - строгость корня (§14): каждое обязательное поле обязательно, посторонний ключ
 *    (секрет/мусор) отвергается — тест-сверка состава корневых ключей;
 *  - counts: оба счётчика обязательны, целые ≥0 (факт, не заявление — §9);
 *  - ломающие кейсы (§19/AC5): нет formatVersion; createdAtUtc строкой («формат
 *    даты»); посторонний корневой ключ — все отвергаются.
 */
import { describe, expect, it } from 'vitest';

import { MEASUREMENT_DTO_SCHEMA } from '../measurement/schemas.js';
import type { MeasurementDto } from '../measurement/types.js';
import { JSON_SNAPSHOT_SCHEMA, type JsonSnapshot } from './json-snapshot-schema.js';

/** База моментов фикстур: 2026-09-24T05:12:00Z (= 08:12:00+03:00). */
const BASE_MS = 1_790_226_720_000;

/** Валидный DTO измерения (§7: форма TASK-028, без critical — серверное поле list). */
const validMeasurement: MeasurementDto = {
  id: 'm-1',
  profileId: 'seed-profile-0001',
  sys: 128,
  dia: 82,
  pulse: 76,
  irregularPulse: false,
  arm: 'left',
  note: 'после прогулки 😊',
  takenAtUtcMs: BASE_MS,
  tzOffsetMin: 180,
  source: 'manual',
  createdAtUtcMs: BASE_MS,
  updatedAtUtcMs: BASE_MS,
};

/** Валидный профиль слепка (§5): id, человекочитаемое имя, момент создания в мс. */
const validProfile = { id: 'seed-profile-0001', name: 'Основной', createdAtUtc: 1_758_816_000_000 };

/** Полная форма слепка (§5): все секции, prefs присутствует. */
const validSnapshot = {
  formatVersion: 1,
  appVersion: '0.0.0',
  createdAtUtc: BASE_MS,
  counts: { measurements: 1, profiles: 1 },
  profiles: [validProfile],
  measurements: [validMeasurement],
  prefs: {
    theme: 'dark',
    textScale: '100',
    dateFormat: 'dmy',
    advancedMode: false,
    netConsents: { updatesCheck: false, modelsDownload: false },
    jobState: { jobs: {}, shown: {} },
    aiSettings: { dismissed: false, includeNotes: false },
    autoLockMin: 5,
  },
  scales: [{ code: 'bp-office-esc2018', version: '1.0.0' }],
};

describe('JSON_SNAPSHOT_SCHEMA — валидные формы (TASK-064 §5/§19)', () => {
  it('валидный минимальный слепок разбирается: пустые массивы, prefs отсутствует (§13)', () => {
    const minimal = {
      formatVersion: 1,
      appVersion: '0.0.0',
      createdAtUtc: BASE_MS,
      counts: { measurements: 0, profiles: 0 },
      profiles: [],
      measurements: [],
      scales: [],
    };
    const parsed: JsonSnapshot = JSON_SNAPSHOT_SCHEMA.parse(minimal);
    expect(parsed).toEqual(minimal);
  });

  it('полная форма разбирается: DTO (§7), профиль, prefs (TASK-047), шкала код/версия', () => {
    expect(JSON_SNAPSHOT_SCHEMA.parse(validSnapshot)).toEqual(validSnapshot);
  });

  it('prefs опционально (§13); prefs: null отвергается — отсутствие это отсутствие ключа', () => {
    const withoutPrefs = { ...validSnapshot } as Record<string, unknown>;
    delete withoutPrefs.prefs;
    expect(JSON_SNAPSHOT_SCHEMA.safeParse(withoutPrefs).success).toBe(true);
    expect(JSON_SNAPSHOT_SCHEMA.safeParse({ ...withoutPrefs, prefs: null }).success).toBe(false);
  });

  it('переиспользование MeasurementDto (§7): пульс/заметка опциональны, критично только для формы', () => {
    // «Пульс не измерен» = ключ pulse отсутствует (JSON не знает undefined) —
    // та же конвенция, что у канала measurements/list (TASK-028).
    const noPulse: MeasurementDto = { ...validMeasurement, pulse: undefined };
    expect(MEASUREMENT_DTO_SCHEMA.safeParse(noPulse).success).toBe(true);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({ ...validSnapshot, measurements: [noPulse] }).success,
    ).toBe(true);
    // Ломающий DTO (лишнее поле) ломает слепок: strict-переиспользование, не новый формат.
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        measurements: [{ ...validMeasurement, extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it('профиль: name непустая строка; createdAtUtc — целое ≥0 (мс эпохи, прецедент BackupManifest)', () => {
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        profiles: [{ ...validProfile, name: '' }],
      }).success,
    ).toBe(false);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        profiles: [{ ...validProfile, createdAtUtc: -1 }],
      }).success,
    ).toBe(false);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        profiles: [{ ...validProfile, createdAtUtc: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it('шкала: code непустой, version — семвер (зеркало SCALE_VERSION_SCHEMA, TASK-051)', () => {
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        scales: [{ code: '', version: '1.0.0' }],
      }).success,
    ).toBe(false);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        scales: [{ code: 'bp-office-esc2018', version: '1.0' }],
      }).success,
    ).toBe(false);
  });
});

describe('JSON_SNAPSHOT_SCHEMA — строгость состава (§9/§14)', () => {
  it('каждое обязательное корневое поле обязательно (prefs — единственное опциональное)', () => {
    const requiredKeys = [
      'formatVersion',
      'appVersion',
      'createdAtUtc',
      'counts',
      'profiles',
      'measurements',
      'scales',
    ];
    for (const key of requiredKeys) {
      const without = { ...validSnapshot } as Record<string, unknown>;
      delete without[key];
      expect(JSON_SNAPSHOT_SCHEMA.safeParse(without).success, `без ${key}`).toBe(false);
    }
  });

  it('counts — оба счётчика обязательны, целые ≥0; лишние поля отвергаются (counts — факт, §9)', () => {
    expect(JSON_SNAPSHOT_SCHEMA.safeParse({ ...validSnapshot, counts: {} }).success).toBe(false);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        counts: { measurements: -1, profiles: 1 },
      }).success,
    ).toBe(false);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        counts: { measurements: 1, profiles: 1, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('counts 1.5/строкой отвергаются — счётчики из фактов (§9)', () => {
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        counts: { measurements: 1.5, profiles: 1 },
      }).success,
    ).toBe(false);
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        counts: { measurements: '1', profiles: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('JSON_SNAPSHOT_SCHEMA — ломающие кейсы отвергаются (§19/AC5)', () => {
  it('ломающий 1: отсутствует formatVersion — отвергается', () => {
    const noVersion = { ...validSnapshot } as Record<string, unknown>;
    delete noVersion.formatVersion;
    expect(JSON_SNAPSHOT_SCHEMA.safeParse(noVersion).success).toBe(false);
  });

  it('ломающий 2: createdAtUtc строкой ISO («формат даты») — отвергается (только мс эпохи)', () => {
    expect(
      JSON_SNAPSHOT_SCHEMA.safeParse({
        ...validSnapshot,
        createdAtUtc: '2026-09-24T05:12:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('ломающий 3: посторонний корневой ключ (секрет/мусор) — отвергается (strict, §14)', () => {
    expect(JSON_SNAPSHOT_SCHEMA.safeParse({ ...validSnapshot, apiKey: 'secret' }).success).toBe(
      false,
    );
  });
});
