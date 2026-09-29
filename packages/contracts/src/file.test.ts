// TASK-073 §9/§11: контракт-тесты канала `file/open-dialog` — выбор файла копии
// для восстановления. Renderer присылает ТОЛЬКО фильтры (§14: путь выбирает
// диалог ОС main — тот же принцип, что save-диалог экспорта 065); ответ — union
// {path} | {canceled: true} (§7: отмена пользователя — не ошибка).
//
// Матрица:
//  - запрос: {filters} разбирается; strict — без filters и с лишними полями
//    отвергается; фильтр без имени/расширений, пустой список расширений — отказ;
//  - ответ: форма {path} и {canceled: true} разбираются; смешанная форма
//    (path+canceled) и лишние поля — отказ;
//  - реестр: CHANNEL_SCHEMAS['file/open-dialog'] — та же пара схем (§23).
import { describe, expect, it } from 'vitest';

import { CHANNEL_SCHEMAS } from './channels.js';
import {
  FILE_OPEN_DIALOG_REQUEST_SCHEMA,
  FILE_OPEN_DIALOG_RESPONSE_SCHEMA,
} from './file.js';

describe('FILE_OPEN_DIALOG_REQUEST_SCHEMA (TASK-073 §9: {filters} — путь не присылается)', () => {
  it('фильтр копии разбирается (§5: выбор файла восстановления .hlbackup)', () => {
    const request = {
      filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
    };
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.parse(request)).toEqual(request);
  });

  it('несколько фильтров разбираются; пустой список допускается', () => {
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.parse({
        filters: [
          { name: 'A', extensions: ['a'] },
          { name: 'B', extensions: ['b', 'c'] },
        ],
      }).filters,
    ).toHaveLength(2);
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.parse({ filters: [] }).filters).toEqual([]);
  });

  it('без filters и с лишними полями — отказ (strict, §14 IPC-гигиена)', () => {
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({
        filters: [],
        path: 'C:\\copy.hlbackup',
      }).success,
    ).toBe(false);
  });

  it('фильтр без имени, без расширений или с пустым списком расширений — отказ', () => {
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({ filters: [{ extensions: ['hlbackup'] }] })
        .success,
    ).toBe(false);
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({ filters: [{ name: 'X' }] }).success).toBe(
      false,
    );
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({ filters: [{ name: 'X', extensions: [] }] })
        .success,
    ).toBe(false);
  });
});

describe('FILE_OPEN_DIALOG_RESPONSE_SCHEMA (TASK-073 §9: {path} | {canceled: true})', () => {
  it('выбранный файл — {path}; отмена пользователя — {canceled: true} (§7)', () => {
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.parse({ path: 'C:\\copies\\x.hlbackup' })).toEqual({
      path: 'C:\\copies\\x.hlbackup',
    });
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.parse({ canceled: true })).toEqual({ canceled: true });
  });

  it('смешанная форма (path+canceled) и лишние поля — отказ (обе ветки strict)', () => {
    expect(
      FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({ path: 'C:\\x', canceled: true }).success,
    ).toBe(false);
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({ path: 'C:\\x', extra: 1 }).success).toBe(
      false,
    );
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({ canceled: true, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("CHANNEL_SCHEMAS['file/open-dialog'] — пара схем зарегистрирована в реестре", () => {
  it('запрос и ответ канала — те же схемы file.ts (§23: переиспользование обязательно)', () => {
    expect(CHANNEL_SCHEMAS['file/open-dialog'].request).toBe(FILE_OPEN_DIALOG_REQUEST_SCHEMA);
    expect(CHANNEL_SCHEMAS['file/open-dialog'].response).toBe(FILE_OPEN_DIALOG_RESPONSE_SCHEMA);
  });
});
