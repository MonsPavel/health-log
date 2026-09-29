// TASK-073 §5/§9/§11/§14: контракт канала file/open-dialog — выбор файла копии
// для восстановления. renderer присылает ТОЛЬКО фильтры диалога (§14: путь
// выбирает main-диалог ОС, renderer путь не предлагает — тот же принцип, что у
// save-каналов report/export-* TASK-065 и DialogFileSaver TASK-070). Ответ —
// union {path} | {canceled: true} (§7: отмена — не ошибка, ожидаемый исход).
import { describe, expect, it } from 'vitest';

import { type ChannelName } from '../channels.js';
import { CHANNEL_SCHEMAS } from '../schemas.js';
import { FILE_OPEN_DIALOG_REQUEST_SCHEMA, FILE_OPEN_DIALOG_RESPONSE_SCHEMA } from './schemas.js';

describe('FILE_OPEN_DIALOG_REQUEST_SCHEMA — запрос выбора файла (§9/§14)', () => {
  it('принимает {filters} — фильтры диалога (имя + расширения без точки)', () => {
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.parse({
        filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
      }),
    ).toEqual({ filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }] });
  });

  it('принимает {} — фильтры необязательны (диалог без фильтра допустим)', () => {
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.parse({})).toEqual({});
  });

  it('strict: путь от renderer отклоняется — путь даёт только main-диалог (§14)', () => {
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({
        filters: [],
        path: 'C:/evil/copy.hlbackup',
      }).success,
    ).toBe(false);
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({ path: 'C:/x.hlbackup' }).success).toBe(
      false,
    );
  });

  it('форма фильтров отвергается: пустое имя, расширение с точкой/символами, не-массив', () => {
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({
        filters: [{ name: '', extensions: ['hlbackup'] }],
      }).success,
    ).toBe(false);
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({
        filters: [{ name: 'X', extensions: ['.hlbackup'] }],
      }).success,
    ).toBe(false);
    expect(
      FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({
        filters: [{ name: 'X', extensions: ['*.*'] }],
      }).success,
    ).toBe(false);
    expect(FILE_OPEN_DIALOG_REQUEST_SCHEMA.safeParse({ filters: 'hlbackup' }).success).toBe(false);
  });
});

describe('FILE_OPEN_DIALOG_RESPONSE_SCHEMA — ответ выбора файла (§9/§7)', () => {
  it('принимает {path} — полный путь выбранного файла (пользователь выбрал сам — наружу можно, §14)', () => {
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.parse({ path: 'C:/Users/me/copy.hlbackup' })).toEqual({
      path: 'C:/Users/me/copy.hlbackup',
    });
  });

  it('принимает {canceled: true} — отмена диалога не ошибка (§7)', () => {
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.parse({ canceled: true })).toEqual({ canceled: true });
  });

  it('strict: смешанные/пустые/не-объектные формы отвергаются (§14 IPC-гигиена)', () => {
    expect(
      FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({ path: 'C:/x', canceled: true }).success,
    ).toBe(false);
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({ path: '' }).success).toBe(false);
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({ canceled: false }).success).toBe(false);
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
    expect(FILE_OPEN_DIALOG_RESPONSE_SCHEMA.safeParse(null).success).toBe(false);
  });
});

describe('дисциплина реестра — канал file/open-dialog (§5/§11)', () => {
  it('канал file/open-dialog использует эти схемы', () => {
    const entry = CHANNEL_SCHEMAS['file/open-dialog'];
    expect(entry.request).toBe(FILE_OPEN_DIALOG_REQUEST_SCHEMA);
    expect(entry.response).toBe(FILE_OPEN_DIALOG_RESPONSE_SCHEMA);
  });

  it('имя канала входит в union ChannelName (компилятор реестра, §5)', () => {
    const names: readonly ChannelName[] = ['file/open-dialog'];
    expect(names).toHaveLength(1);
  });

  it('реестр содержит file/open-dialog после data/wipe (состав CHANNEL_SCHEMAS, §5)', () => {
    const keys = Object.keys(CHANNEL_SCHEMAS);
    const wipe = keys.indexOf('data/wipe');
    const openDialog = keys.indexOf('file/open-dialog');
    expect(openDialog).toBeGreaterThan(-1);
    expect(openDialog).toBe(wipe + 1);
  });
});
