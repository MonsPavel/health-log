// TASK-068 §5/§11/§19: схемы каналов `report/pdf` (сборка+сохранение PDF-отчёта)
// и `app/reveal-path` (открыть папку с файлом — shell.showItemInFolder).
// report/pdf: запрос {profileId, period, includeAiSection, aiText?} — период в
// готовых utcMs-границах (ReportPeriod 067), aiText — параметр от вызывающего
// (§5 РЕШЕНИЕ: use case агностичен к ИИ-хранилищу; в P4 чекбокс disabled — §12).
// Ответ — ТА ЖЕ union {path} | {canceled: true}, что у экспорта (§5, переиспользование).
// app/reveal-path: {path} → null (fire-and-forget, §9/§11: путь — UX-удобство на
// своей машине, решение §11 документировано — санитизация не требуется).
import { describe, expect, it } from 'vitest';

import { type ChannelName } from '../channels.js';
import { CHANNEL_SCHEMAS } from '../schemas.js';
import { REPORT_PDF_REQUEST_SCHEMA, REVEAL_PATH_REQUEST_SCHEMA } from './schemas.js';

const VALID_REQUEST = {
  profileId: 'seed-profile-0001',
  period: { fromUtcMs: 1_758_000_000_000, toUtcMs: 1_758_816_000_000 },
  includeAiSection: false,
};

describe('REPORT_PDF_REQUEST_SCHEMA — запрос сборки PDF-отчёта (§11)', () => {
  it('принимает {profileId, period{fromUtcMs,toUtcMs}, includeAiSection}', () => {
    expect(REPORT_PDF_REQUEST_SCHEMA.parse(VALID_REQUEST)).toEqual(VALID_REQUEST);
  });

  it('принимает aiText {contentMd, generatedAt, modelId} (§5: параметр вызывающего)', () => {
    const withAi = {
      ...VALID_REQUEST,
      includeAiSection: true,
      aiText: { contentMd: '# Резюме', generatedAt: 1_758_500_000_000, modelId: 'test-model' },
    };
    expect(REPORT_PDF_REQUEST_SCHEMA.parse(withAi)).toEqual(withAi);
  });

  it('strict: лишние поля, пустой profileId и неполные формы отклоняются (§14)', () => {
    expect(
      REPORT_PDF_REQUEST_SCHEMA.safeParse({ ...VALID_REQUEST, path: 'C:/evil.pdf' }).success,
    ).toBe(false);
    expect(REPORT_PDF_REQUEST_SCHEMA.safeParse({ ...VALID_REQUEST, profileId: '' }).success).toBe(
      false,
    );
    expect(
      REPORT_PDF_REQUEST_SCHEMA.safeParse({ ...VALID_REQUEST, includeAiSection: 'yes' }).success,
    ).toBe(false);
    // Период без одной границы — не ReportPeriod (067: обе включительно).
    expect(
      REPORT_PDF_REQUEST_SCHEMA.safeParse({
        profileId: 'p',
        period: { fromUtcMs: 1 },
        includeAiSection: false,
      }).success,
    ).toBe(false);
    // aiText без modelId — не ReportAiText (067).
    expect(
      REPORT_PDF_REQUEST_SCHEMA.safeParse({
        ...VALID_REQUEST,
        includeAiSection: true,
        aiText: { contentMd: 'x', generatedAt: 1 },
      }).success,
    ).toBe(false);
    expect(REPORT_PDF_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(REPORT_PDF_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
  });

  it('канал report/pdf использует эту схему запроса и union-ответ экспорта', () => {
    const pdf = CHANNEL_SCHEMAS['report/pdf'];
    expect(pdf.request).toBe(REPORT_PDF_REQUEST_SCHEMA);
    expect(pdf.response).toBe(CHANNEL_SCHEMAS['report/export-csv'].response);
  });

  it('имена каналов report/pdf и app/reveal-path входят в union ChannelName (§5)', () => {
    const names: readonly ChannelName[] = ['report/pdf', 'app/reveal-path'];
    expect(names).toHaveLength(2);
  });
});

describe('REVEAL_PATH_REQUEST_SCHEMA — запрос «открыть папку» (§11)', () => {
  it('принимает {path} — путь, который вернул наш же экспорт (§5)', () => {
    expect(REVEAL_PATH_REQUEST_SCHEMA.parse({ path: 'C:/out/report.pdf' })).toEqual({
      path: 'C:/out/report.pdf',
    });
  });

  it('strict: пустой путь, лишние поля и не-строка отклоняются (§14)', () => {
    expect(REVEAL_PATH_REQUEST_SCHEMA.safeParse({ path: '' }).success).toBe(false);
    expect(REVEAL_PATH_REQUEST_SCHEMA.safeParse({ path: 'C:/x.pdf', extra: 1 }).success).toBe(
      false,
    );
    expect(REVEAL_PATH_REQUEST_SCHEMA.safeParse({ path: 42 }).success).toBe(false);
    expect(REVEAL_PATH_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('канал app/reveal-path: ответ null (fire-and-forget, §9/§11)', () => {
    const reveal = CHANNEL_SCHEMAS['app/reveal-path'];
    expect(reveal.request).toBe(REVEAL_PATH_REQUEST_SCHEMA);
    expect(reveal.response.safeParse(null).success).toBe(true);
    expect(reveal.response.safeParse({}).success).toBe(false);
  });
});
