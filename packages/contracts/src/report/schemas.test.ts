// TASK-065 §5/§11/§19: схемы каналов экспорта `report/export-csv|export-json`.
// Запрос: {profileId} — ЕДИНСТВЕННОЕ поле от renderer (§14: путь файла выбирает
// main-диалог, renderer путь не присылает — защита «renderer просит записать в
// произвольный путь» архитектурно исключена). Ответ: union {path} | {canceled: true}
// (§7: отмена — не ошибка, ожидаемый исход; формы strict, смешанная отвергается).
import { describe, expect, it } from 'vitest';

import { type ChannelName } from '../channels.js';
import { CHANNEL_SCHEMAS } from '../schemas.js';
import { REPORT_EXPORT_REQUEST_SCHEMA, REPORT_EXPORT_RESPONSE_SCHEMA } from './schemas.js';

describe('REPORT_EXPORT_REQUEST_SCHEMA — запрос экспорта (§11/§14)', () => {
  it('принимает {profileId} — единственное поле (путь выбирает main-диалог, §14)', () => {
    expect(REPORT_EXPORT_REQUEST_SCHEMA.parse({ profileId: 'seed-profile-0001' })).toEqual({
      profileId: 'seed-profile-0001',
    });
  });

  it('strict: лишние поля (path от renderer!) и пустой profileId отклоняются (§14)', () => {
    // §14-гвард: renderer НЕ может попросить записать в произвольный путь.
    expect(
      REPORT_EXPORT_REQUEST_SCHEMA.safeParse({ profileId: 'p', path: 'C:/evil/x.csv' }).success,
    ).toBe(false);
    expect(REPORT_EXPORT_REQUEST_SCHEMA.safeParse({ profileId: '' }).success).toBe(false);
    expect(REPORT_EXPORT_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(REPORT_EXPORT_REQUEST_SCHEMA.safeParse({ profileId: 42 }).success).toBe(false);
  });

  it('каналы report/export-csv и report/export-json используют эти схемы', () => {
    const csv = CHANNEL_SCHEMAS['report/export-csv'];
    const json = CHANNEL_SCHEMAS['report/export-json'];
    expect(csv.request).toBe(REPORT_EXPORT_REQUEST_SCHEMA);
    expect(csv.response).toBe(REPORT_EXPORT_RESPONSE_SCHEMA);
    expect(json.request).toBe(REPORT_EXPORT_REQUEST_SCHEMA);
    expect(json.response).toBe(REPORT_EXPORT_RESPONSE_SCHEMA);
  });

  it('имена каналов входят в union ChannelName (компилятор реестра, §5)', () => {
    const names: readonly ChannelName[] = ['report/export-csv', 'report/export-json'];
    expect(names).toHaveLength(2);
  });
});

describe('REPORT_EXPORT_RESPONSE_SCHEMA — ответ экспорта (§5/§7)', () => {
  it('принимает {path} — полный путь выбранного файла (тост: basename + title, §10)', () => {
    expect(
      REPORT_EXPORT_RESPONSE_SCHEMA.parse({ path: 'C:/Users/me/health-log-export.csv' }),
    ).toEqual({ path: 'C:/Users/me/health-log-export.csv' });
  });

  it('принимает {canceled: true} — отмена диалога не ошибка (§7)', () => {
    expect(REPORT_EXPORT_RESPONSE_SCHEMA.parse({ canceled: true })).toEqual({ canceled: true });
  });

  it('strict: смешанные/лишние формы отвергаются (§14 IPC-гигиена)', () => {
    expect(
      REPORT_EXPORT_RESPONSE_SCHEMA.safeParse({ path: 'C:/x.csv', canceled: true }).success,
    ).toBe(false);
    expect(REPORT_EXPORT_RESPONSE_SCHEMA.safeParse({ path: '' }).success).toBe(false);
    expect(REPORT_EXPORT_RESPONSE_SCHEMA.safeParse({ canceled: false }).success).toBe(false);
    expect(REPORT_EXPORT_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
    expect(REPORT_EXPORT_RESPONSE_SCHEMA.safeParse('C:/x.csv').success).toBe(false);
  });
});
