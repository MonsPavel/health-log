// TASK-067 §19/§20: юниты компонентов шаблона — чистая логика (ИИ-раздел при
// флаге false, сборка таблицы с лимитом 2000) и байтовые проверки (golden-хеш
// AC2, отсутствие ИИ-раздела в bytes AC3, разумное число страниц, кириллица
// через встроенный Roboto — ранний чек §4 как регрессионный тест).
import { createHash } from 'node:crypto';

import { renderToBuffer } from '@react-pdf/renderer';
import { describe, expect, it } from 'vitest';

import { GOLDEN_AI_TEXT, GOLDEN_PAYLOAD } from './__fixtures__/golden-payload.ts';
import { buildTableSection, createReportDocument, resolveAiText } from './report-document.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const render = async (payload: typeof GOLDEN_PAYLOAD): Promise<Uint8Array> =>
  new Uint8Array(await renderToBuffer(createReportDocument(payload)));

describe('resolveAiText — ИИ-раздел только по явному включению (§13)', () => {
  it('includeAiSection=false + переданный aiText → текст ИГНОРИРУЕТСЯ (§13/AC3)', () => {
    const spec = { ...GOLDEN_PAYLOAD.spec, includeAiSection: false, aiText: GOLDEN_AI_TEXT };
    expect(resolveAiText(spec)).toBeUndefined();
  });

  it('includeAiSection=true + aiText → раздел рендерится', () => {
    const spec = { ...GOLDEN_PAYLOAD.spec, includeAiSection: true, aiText: GOLDEN_AI_TEXT };
    expect(resolveAiText(spec)).toEqual(GOLDEN_AI_TEXT);
  });

  it('includeAiSection=true без текста → раздела нет (нечего маркировать)', () => {
    const spec = { ...GOLDEN_PAYLOAD.spec, includeAiSection: true };
    expect(resolveAiText(spec)).toBeUndefined();
  });
});

describe('buildTableSection — сборка таблицы: лимит 2000 (§9) + страницы (§19)', () => {
  it('3000 записей → последние 2000, приписка «последние 2000 из 3000» (AC5)', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      utcMs: i,
      tzOffsetMin: 180,
      sys: 120,
      dia: 80,
    }));
    const section = buildTableSection(rows);
    expect(section.total).toBe(3000);
    expect(section.omitted).toBe(1000);
    expect(section.limitNote).toEqual({ shown: 2000, total: 3000 });
    // 2000 строк по 30 на страницу = 67 страниц (66×30 + 20).
    expect(section.pages).toHaveLength(67);
    expect(section.pages[0]).toHaveLength(30);
    // Хвост периода: первая строка первой страницы — 1000-я запись asc-входа.
    expect(section.pages[0]?.[0]?.utcMs).toBe(1000);
  });

  it('≤ 2000 записей — без приписки', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      utcMs: i,
      tzOffsetMin: 180,
      sys: 120,
      dia: 80,
    }));
    const section = buildTableSection(rows);
    expect(section.omitted).toBe(0);
    expect(section.limitNote).toBeUndefined();
    expect(section.pages).toEqual([rows.slice(0, 30), rows.slice(30, 40)]);
  });

  it('пустой период — таблицы нет (валидная структура без NaN)', () => {
    expect(buildTableSection([])).toEqual({
      pages: [],
      total: 0,
      omitted: 0,
      limitNote: undefined,
    });
  });
});

describe('golden-рендер фикстуры (§19/AC §20)', () => {
  it('AC2: два рендера → идентичные байты (детерминизм react-pdf)', async () => {
    const first = await render(GOLDEN_PAYLOAD);
    const second = await render(GOLDEN_PAYLOAD);
    expect(sha256(first)).toBe(sha256(second));
  }, 30_000);

  it('детерминизм не зависит от порядка ключей/копии payload (structured clone мэйн→воркер)', async () => {
    const cloned = structuredClone(GOLDEN_PAYLOAD);
    const direct = await render(GOLDEN_PAYLOAD);
    const clonedBytes = await render(cloned);
    expect(sha256(clonedBytes)).toBe(sha256(direct));
  }, 30_000);

  it('%PDF-заголовок и число страниц разумное: 40 записей → 2..6 страниц (§5)', async () => {
    const bytes = await render(GOLDEN_PAYLOAD);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const pages = countPages(bytes);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThanOrEqual(6);
  }, 30_000);

  it('кириллица через встроенный Roboto: шрифт вшит в PDF (FontFile2, ранний чек §4)', async () => {
    const bytes = await render(GOLDEN_PAYLOAD);
    const latin = Buffer.from(bytes).toString('latin1');
    expect(latin).toContain('/FontFile2');
  }, 30_000);

  it('AC3: includeAiSection=false + aiText → байты КАК БЕЗ aiText вовсе (раздел не протекает)', async () => {
    const withIgnoredAi = await render({
      ...GOLDEN_PAYLOAD,
      spec: { ...GOLDEN_PAYLOAD.spec, includeAiSection: false, aiText: GOLDEN_AI_TEXT },
    });
    const withoutAi = await render(GOLDEN_PAYLOAD);
    expect(sha256(withIgnoredAi)).toBe(sha256(withoutAi));
  }, 30_000);

  it('AC-санити: includeAiSection=true + aiText → байты ИНЫЕ (раздел действительно рендерится)', async () => {
    const withAi = await render({
      ...GOLDEN_PAYLOAD,
      spec: { ...GOLDEN_PAYLOAD.spec, includeAiSection: true, aiText: GOLDEN_AI_TEXT },
    });
    const withoutAi = await render(GOLDEN_PAYLOAD);
    expect(sha256(withAi)).not.toBe(sha256(withoutAi));
    // Включённый раздел добавляет страницу/контент — документ не меньше.
    expect(countPages(withAi)).toBeGreaterThanOrEqual(countPages(withoutAi));
  }, 30_000);

  it('утро/вечер отсутствуют → «—» в средних (§13), рендер без краша и байты иные', async () => {
    const withoutParts = await render({
      ...GOLDEN_PAYLOAD,
      data: {
        ...GOLDEN_PAYLOAD.data,
        averages: { period: GOLDEN_PAYLOAD.data.averages.period },
      },
    });
    const golden = await render(GOLDEN_PAYLOAD);
    expect(sha256(withoutParts)).not.toBe(sha256(golden));
    expect(countPages(withoutParts)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('пустой период (0 строк) — валидный рендер без NaN/краша (§9 052: пустой период — корректная структура)', async () => {
    const empty = await render({ ...GOLDEN_PAYLOAD, data: { ...GOLDEN_PAYLOAD.data, rows: [] } });
    expect(Buffer.from(empty.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(countPages(empty)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

/** Число страниц PDF: /Type /Page без 's' (словари страниц не сжимаются pdfkit). */
function countPages(bytes: Uint8Array): number {
  const latin = Buffer.from(bytes).toString('latin1');
  return (latin.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}
