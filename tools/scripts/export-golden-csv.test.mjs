// TASK-063 §20.1/§24 (приёмка): генератор golden-файла для РУЧНОЙ Excel-проверки
// («открыть сгенерированный файл в Excel — колонки/кириллица/переносы корректны»,
// скриншот в PR). Среда CI/агента без GUI сам шаг выполнить не может — скрипт делает
// его воспроизводимым одной командой: файл создаётся ПОЛНЫМ боевым путём приложения
// (tmp-v1-БД → SqliteBpMeasurementRepository → MeasurementExportAdapter →
// ExportCsvUseCase) на той же матрице фикстур, что reporting-export-csv.int.test.ts
// (золотая заметка `болит; голова "сильно"`, перенос в заметке, эмодзи, пустые
// ячейки, чужой профиль для скоупа).
//
// Матрица теста:
//  - файл записан в UTF-8 и начинается с байтов BOM EF BB BF (§20: Excel в ru-локали);
//  - разделитель `;`, переводы строк CRLF, 6 строк (заголовок + 5 записей);
//  - золотая заметка закавычена RFC 4180 с удвоением (`""сильно""`);
//  - эмодзи/кириллица в байтах файла (UTF-8, без искажений);
//  - скоуп: записей профиля-2 в файле нет.
//
// Запуск утилиты: `pnpm export:golden-csv [--out <path>]` (по умолчанию
// tools/export-samples/TASK-063-golden.csv — в .gitignore, артефакт ручной проверки).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { run } from './export-golden-csv.mjs';

describe('export-golden-csv: golden-файл для ручной Excel-проверки (TASK-063 §20.1/§24)', () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'hl-golden-csv-'))];

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('файл боевым путём: BOM EF BB BF, «;», CRLF, 6 строк, золотая заметка, эмодзи, без profile-2', async () => {
    const outPath = join(dirs[0], 'golden.csv');

    const result = await run({ out: outPath });

    expect(result.count).toBe(5);
    const bytes = readFileSync(outPath);
    // §20: BOM обязателен — иначе Excel в ru-локали открывает UTF-8 как CP1251.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = bytes.toString('utf8');
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(6); // заголовок + 5 записей (записи CRLF-разделителем)
    expect(lines[0]).toBe('id;profileId;datetime;sys;dia;pulse;irregular;arm;note;source');
    // Хронология asc (§13): первая запись — самая старая фикстура (2026-09-20);
    // id — uuid v7 из доменной фабрики (полный боевой путь), хвост строки золотой.
    expect(lines[1]).toMatch(
      /^[0-9a-f-]{36};profile-1;2026-09-20T07:45:00\+03:00;118;76;;true;right;;manual$/,
    );
    // Золотая заметка §20.1: RFC 4180-кавычки с удвоением внутренних.
    expect(text).toContain('"болит; голова ""сильно"""');
    // Эмодзи и перенос внутри кавычек — без искажений (§20 п. 5).
    expect(text).toContain('"вечерний замер\nпосле тренировки 💪"');
    // Скоуп профиля (§14): чужой профиль не в файле.
    expect(text).not.toContain('profile-2');
    expect(result.outPath).toBe(outPath);
  });
});
