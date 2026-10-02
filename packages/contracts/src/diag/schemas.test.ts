// TASK-103 §5/§7/§11: контракты диагностического пакета — DiagContent (§7: files +
// totals.eventsByKind), каналы `diag/preview` ({} → DiagContent) и `diag/save`
// ({} → {path} | {canceled: true}, паттерн 065). Схемы strict (§14 IPC-гигиены);
// оба канала secure — чтение БД (app_event/network_event) и файловой системы.
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DIAG_PREVIEW_REQUEST_SCHEMA,
  DIAG_PREVIEW_RESPONSE_SCHEMA,
  DIAG_SAVE_REQUEST_SCHEMA,
  DIAG_SAVE_RESPONSE_SCHEMA,
  type DiagContent,
  type DiagFileEntry,
} from './schemas.js';
import { CHANNEL_SCHEMAS } from '../schemas.js';

describe('DIAG_PREVIEW_REQUEST_SCHEMA — запрос {} (сборка целиком в main, §14)', () => {
  it('принимает пустой объект', () => {
    expect(DIAG_PREVIEW_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
  });

  it('отклоняет лишние ключи и не-объекты (strict)', () => {
    expect(DIAG_PREVIEW_REQUEST_SCHEMA.safeParse({ limit: 10 }).success).toBe(false);
    expect(DIAG_PREVIEW_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
    expect(DIAG_PREVIEW_REQUEST_SCHEMA.safeParse('preview').success).toBe(false);
  });
});

describe('DIAG_PREVIEW_RESPONSE_SCHEMA — DiagContent (§7)', () => {
  const CONTENT: DiagContent = {
    files: [
      { name: 'logs/hl.1.log', sizeBytes: 2048, preview: 'первая строка\nвторая строка' },
      { name: 'selfcheck.json', sizeBytes: 256 },
    ],
    totals: { eventsByKind: { 'models.download': 3, 'updates.check': 1 } },
  };

  it('принимает корректный DiagContent: файлы с опциональным preview + агрегаты', () => {
    expect(DIAG_PREVIEW_RESPONSE_SCHEMA.safeParse(CONTENT).success).toBe(true);
  });

  it('принимает пустой пакет (нет файлов/событий) — валидный ответ, не ошибка', () => {
    expect(
      DIAG_PREVIEW_RESPONSE_SCHEMA.safeParse({ files: [], totals: { eventsByKind: {} } }).success,
    ).toBe(true);
  });

  it('отклоняет неизвестные ключи, отрицательные размеры, пустое имя файла (strict)', () => {
    expect(
      DIAG_PREVIEW_RESPONSE_SCHEMA.safeParse({
        files: [{ name: 'a', sizeBytes: 1, extra: true }],
        totals: { eventsByKind: {} },
      }).success,
    ).toBe(false);
    expect(
      DIAG_PREVIEW_RESPONSE_SCHEMA.safeParse({
        files: [{ name: 'a', sizeBytes: -1 }],
        totals: { eventsByKind: {} },
      }).success,
    ).toBe(false);
    expect(
      DIAG_PREVIEW_RESPONSE_SCHEMA.safeParse({
        files: [{ name: '', sizeBytes: 1 }],
        totals: { eventsByKind: {} },
      }).success,
    ).toBe(false);
    expect(
      DIAG_PREVIEW_RESPONSE_SCHEMA.safeParse({ files: [], totals: {} }).success,
    ).toBe(false);
  });

  it('типы выводятся из схем (§23: без ручной синхронизации)', () => {
    expectTypeOf<DiagFileEntry>().toEqualTypeOf<{
      name: string;
      sizeBytes: number;
      preview?: string;
    }>();
  });
});

describe('DIAG_SAVE_REQUEST/RESPONSE — {} → {path} | {canceled: true} (паттерн 065, §11)', () => {
  it('запрос — только {}', () => {
    expect(DIAG_SAVE_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(DIAG_SAVE_REQUEST_SCHEMA.safeParse({ targetPath: 'C:/x.zip' }).success).toBe(false);
  });

  it('ответ — union {path} | {canceled: true}; формы различны по ключам', () => {
    expect(DIAG_SAVE_RESPONSE_SCHEMA.safeParse({ path: 'C:/diag/diag.zip' }).success).toBe(true);
    expect(DIAG_SAVE_RESPONSE_SCHEMA.safeParse({ canceled: true }).success).toBe(true);
    // Отмена без литерала true, пустой union-член и смесь ключей — отказ.
    expect(DIAG_SAVE_RESPONSE_SCHEMA.safeParse({ canceled: false }).success).toBe(false);
    expect(DIAG_SAVE_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
    expect(
      DIAG_SAVE_RESPONSE_SCHEMA.safeParse({ path: 'a.zip', canceled: true }).success,
    ).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS — регистрация каналов diag/* (§11)', () => {
  it('diag/preview и diag/save зарегистрированы, secure (чтение БД/ФС, §14)', () => {
    expect(CHANNEL_SCHEMAS['diag/preview']).toBeDefined();
    expect(CHANNEL_SCHEMAS['diag/save']).toBeDefined();
    expect(CHANNEL_SCHEMAS['diag/preview'].secure).toBe(true);
    expect(CHANNEL_SCHEMAS['diag/save'].secure).toBe(true);
  });
});
