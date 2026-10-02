// TASK-103 §19: schema-тесты контрактов диагностического пакета — zod на границе
// доверия (прецедент schemas.test.ts TASK-008): strict-объекты против
// prototype-pollution (§14), union ответа save-канала (отмена — не ошибка, §7 065).
import { describe, expect, it } from 'vitest';

import { CHANNEL_SCHEMAS } from '../schemas.js';
import {
  DIAG_CONTENT_SCHEMA,
  DIAG_FILE_SCHEMA,
  DIAG_MANIFEST_SCHEMA,
} from './schemas.js';

const PREVIEW = CHANNEL_SCHEMAS['diag/preview'];
const SAVE = CHANNEL_SCHEMAS['diag/save'];

const FILE = { name: 'hl.1.log', sizeBytes: 1024, preview: 'line1\nline2' };
const CONTENT = {
  files: [FILE, { name: 'diag-manifest.json', sizeBytes: 64 }],
  totals: { eventsByKind: { 'models.download': 3, 'updates.check': 0 } },
};

describe('DIAG_FILE_SCHEMA — файл пакета (§7: name, sizeBytes, preview?)', () => {
  it('принимает файл с preview и без', () => {
    expect(DIAG_FILE_SCHEMA.safeParse(FILE).success).toBe(true);
    expect(DIAG_FILE_SCHEMA.safeParse({ name: 'x.json', sizeBytes: 0 }).success).toBe(true);
  });

  it('отклоняет отрицательный размер и пустое имя (§14)', () => {
    expect(DIAG_FILE_SCHEMA.safeParse({ name: 'x', sizeBytes: -1 }).success).toBe(false);
    expect(DIAG_FILE_SCHEMA.safeParse({ name: '', sizeBytes: 0 }).success).toBe(false);
  });

  it('strict: отклоняет неизвестные поля (prototype-pollution, §14)', () => {
    expect(DIAG_FILE_SCHEMA.safeParse({ ...FILE, text: 'leak' }).success).toBe(false);
    const pollution: object = JSON.parse('{"__proto__": {"isAdmin": true}}') as object;
    expect(DIAG_FILE_SCHEMA.safeParse({ name: 'x', sizeBytes: 1, ...pollution }).success).toBe(
      false,
    );
  });
});

describe('DIAG_CONTENT_SCHEMA — предпросмотр содержимого пакета (§7)', () => {
  it('принимает полный контент: файлы + агрегаты событий по kind', () => {
    expect(DIAG_CONTENT_SCHEMA.safeParse(CONTENT).success).toBe(true);
  });

  it('принимает пустой пакет (чистая установка: нет логов, нет событий)', () => {
    expect(DIAG_CONTENT_SCHEMA.safeParse({ files: [], totals: { eventsByKind: {} } }).success).toBe(
      true,
    );
  });

  it('отклоняет отрицательные счётчики агрегатов (§14)', () => {
    expect(
      DIAG_CONTENT_SCHEMA.safeParse({
        files: [],
        totals: { eventsByKind: { 'models.download': -1 } },
      }).success,
    ).toBe(false);
  });

  it('strict: отклоняет тексты файлов целиком (в контракте только preview)', () => {
    expect(DIAG_CONTENT_SCHEMA.safeParse({ ...CONTENT, texts: {} }).success).toBe(false);
  });
});

describe('DIAG_MANIFEST_SCHEMA — манифест zip-пакета (§5: версия формата, дата)', () => {
  it('принимает {formatVersion: 1, createdAtUtc: epoch ms}', () => {
    expect(
      DIAG_MANIFEST_SCHEMA.safeParse({ formatVersion: 1, createdAtUtc: 1_759_400_000_000 }).success,
    ).toBe(true);
  });

  it('отклоняет formatVersion < 1 и отрицательную дату (§14)', () => {
    expect(DIAG_MANIFEST_SCHEMA.safeParse({ formatVersion: 0, createdAtUtc: 0 }).success).toBe(
      false,
    );
    expect(
      DIAG_MANIFEST_SCHEMA.safeParse({ formatVersion: 1, createdAtUtc: -1 }).success,
    ).toBe(false);
  });

  it('strict: отклоняет неизвестные поля', () => {
    expect(
      DIAG_MANIFEST_SCHEMA.safeParse({ formatVersion: 1, createdAtUtc: 0, phi: true }).success,
    ).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS["diag/preview"] — {} → DiagContent (§11)', () => {
  it('запрос {} принимается, payload отклоняется (strict)', () => {
    expect(PREVIEW.request.safeParse({}).success).toBe(true);
    expect(PREVIEW.request.safeParse({ limit: 5 }).success).toBe(false);
  });

  it('ответ принимает DiagContent, отклоняет мусор', () => {
    expect(PREVIEW.response.safeParse(CONTENT).success).toBe(true);
    expect(PREVIEW.response.safeParse({ files: [] }).success).toBe(false);
  });

  it('secure: БД-канал (журнал сети/агрегаты — network_event/app_event, §7/§11)', () => {
    expect(PREVIEW.secure).toBe(true);
  });
});

describe('CHANNEL_SCHEMAS["diag/save"] — {} → {path} | {canceled: true} (§11, паттерн 065)', () => {
  it('запрос {} принимается (путь выбирает main-диалог, renderer путь не шлёт)', () => {
    expect(SAVE.request.safeParse({}).success).toBe(true);
    expect(SAVE.request.safeParse({ path: 'C:\\x.zip' }).success).toBe(false);
  });

  it('ответ — union: {path} при сохранении, {canceled: true} при отмене диалога (§7 065)', () => {
    expect(SAVE.response.safeParse({ path: 'D:\\diag.zip' }).success).toBe(true);
    expect(SAVE.response.safeParse({ canceled: true }).success).toBe(true);
    expect(SAVE.response.safeParse({}).success).toBe(false);
    expect(SAVE.response.safeParse({ path: '' }).success).toBe(false);
  });

  it('secure: сборка читает БД и пишет файл в ФС (§7/§11)', () => {
    expect(SAVE.secure).toBe(true);
  });
});
