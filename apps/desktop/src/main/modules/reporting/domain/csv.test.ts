// TASK-063 §19: юниты чистого конвертера toCsv. Матрица:
//  - golden: пустой набор → только BOM + заголовок (§20: пустой журнал → валидный CSV);
//  - golden: строка без спецсимволов — без кавычек (минимальное кавычкирование §13);
//  - golden §20: заметка `болит; голова "сильно"` → кавычки + удвоение внутренних `""`;
//  - перенос строки в заметке (\n и \r\n) сохраняется ВНУТРИ кавычек (§13);
//  - опциональные поля (pulse/arm/note без значения) → пустые ячейки; irregular —
//    литералы true/false (§5);
//  - юникод/эмодзи без искажений — roundtrip собственным mini-парсером тестов (§19/§20);
//  - property (fast-check): roundtrip произвольной заметки + минимальность кавычек
//    (поле в кавычках ⇔ содержит ; " \r \n — §13);
//  - производительность §15/§20: 5k строк ≤300 мс (тест-таймер).
import { performance } from 'node:perf_hooks';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toCsv, type ExportRow } from './csv.js';

/** Полная строка заголовка (§16–17: английские идентификаторы, разделитель `;`). */
const HEADER = 'id;profileId;datetime;sys;dia;pulse;irregular;arm;note;source';

/** BOM — первый символ файла (§5): иначе Excel открывает UTF-8 как CP1251. */
const BOM = '\uFEFF';

/** Запись без спецсимволов — базовая фабрика фикстур (§19). */
const row = (overrides: Partial<ExportRow> = {}): ExportRow => ({
  id: 'm-1',
  profileId: 'profile-1',
  datetime: '2026-09-24T08:12:00+03:00',
  sys: 120,
  dia: 80,
  pulse: 72,
  irregular: false,
  arm: 'left',
  note: 'после пробежки',
  source: 'manual',
  ...overrides,
});

/**
 * Mini-парсер тестов (§19: roundtrip-парсинг собственным парсером): RFC 4180 с
 * разделителем `;`, BOM снимается. Возвращает записи как массивы полей-строк.
 */
function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ';') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

describe('toCsv — золотые строки (§19 golden)', () => {
  it('пустой набор → BOM + только заголовок (§9/§20: пустой журнал — валидный CSV, не ошибка)', () => {
    expect(toCsv([])).toBe(`${BOM}${HEADER}`);
  });

  it('UTF-8-байты вывода начинаются с EF BB BF — байтовый BOM, который читает Excel (§20.1/§24 приёмка: свойство уже реализовано, тест-фиксация от регрессии)', () => {
    const bytes = Buffer.from(toCsv([row()]), 'utf8');
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('строка без спецсимволов — поля без кавычек, разделитель `;` (§13)', () => {
    expect(toCsv([row()])).toBe(
      `${BOM}${HEADER}\r\nm-1;profile-1;2026-09-24T08:12:00+03:00;120;80;72;false;left;после пробежки;manual`,
    );
  });

  it('§20 golden: заметка `болит; голова "сильно"` → поле в кавычках, внутренние кавычки удвоены (§13)', () => {
    expect(toCsv([row({ note: 'болит; голова "сильно"' })])).toBe(
      `${BOM}${HEADER}\r\nm-1;profile-1;2026-09-24T08:12:00+03:00;120;80;72;false;left;"болит; голова ""сильно""";manual`,
    );
  });

  it('перенос строки в заметке сохраняется внутри кавычек: \\n и \\r\\n (§13)', () => {
    const csv = toCsv([
      row({ id: 'a', note: 'утро\nдавление в норме' }),
      row({ id: 'b', note: 'вечер\r\nизмерение после еды' }),
    ]);
    expect(csv).toBe(
      `${BOM}${HEADER}\r\n` +
        `a;profile-1;2026-09-24T08:12:00+03:00;120;80;72;false;left;"утро\nдавление в норме";manual\r\n` +
        `b;profile-1;2026-09-24T08:12:00+03:00;120;80;72;false;left;"вечер\r\nизмерение после еды";manual`,
    );
  });

  it('опциональные поля без значения → пустые ячейки; irregular — литералы true/false (§5)', () => {
    expect(
      toCsv([row({ pulse: undefined, arm: undefined, note: undefined, irregular: true })]),
    ).toBe(`${BOM}${HEADER}\r\nm-1;profile-1;2026-09-24T08:12:00+03:00;120;80;;true;;;manual`);
  });

  it('два порядка строк сохраняются как пришли (порядок asc — забота use case, §13)', () => {
    const csv = toCsv([row({ id: 'b' }), row({ id: 'a' })]);
    const lines = csv.split('\r\n');
    expect(lines[1]?.startsWith('b;')).toBe(true);
    expect(lines[2]?.startsWith('a;')).toBe(true);
  });
});

describe('toCsv — roundtrip mini-парсером (§19/§20: юникод/эмодзи без искажений)', () => {
  it('заметка с кириллицей, эмодзи, `;`, кавычками и переносом — поля совпадают поле-в-поле', () => {
    const tricky = row({
      id: 'x1',
      note: 'эмодзи 😊; кавычки "х"; перенос\nстроки\r\nи табуляция\tвнутри',
    });
    const records = parseCsv(toCsv([tricky]));
    expect(records).toEqual([
      HEADER.split(';'),
      [
        'x1',
        'profile-1',
        '2026-09-24T08:12:00+03:00',
        '120',
        '80',
        '72',
        'false',
        'left',
        'эмодзи 😊; кавычки "х"; перенос\nстроки\r\nи табуляция\tвнутри',
        'manual',
      ],
    ]);
  });

  it('property: произвольная заметка переживает roundtrip; кавычки минимальны (§13)', () => {
    fc.assert(
      fc.property(fc.string({ maxSize: 200 }), (note) => {
        const csv = toCsv([row({ note })]);
        const records = parseCsv(csv);
        expect(records).toHaveLength(2);
        expect(records[1]?.[8]).toBe(note);
        // Минимальность: без спецсимволов поле без кавычек; с ними — в кавычках (§13).
        const raw = csv.split('\r\n')[1] ?? '';
        if (/[";\r\n]/.test(note)) {
          expect(raw).toContain('"');
        } else {
          expect(raw.includes('"')).toBe(false);
        }
      }),
    );
  });
});

describe('toCsv — производительность (§15/§20)', () => {
  it('5k строк ≤300 мс (тест-таймер)', () => {
    const rows: ExportRow[] = Array.from({ length: 5_000 }, (_, i) =>
      row({
        id: `id-${i}`,
        datetime: '2026-09-24T08:12:00+03:00',
        note: i % 3 === 0 ? `заметка ${i}; с "кавычками"` : undefined,
      }),
    );

    const startedAtMs = performance.now();
    const csv = toCsv(rows);
    const elapsedMs = performance.now() - startedAtMs;

    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(5_001); // заголовок + 5k строк
    expect(elapsedMs).toBeLessThanOrEqual(300);
  });
});
