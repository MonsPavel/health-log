// TASK-069 §5/§14/§20 AC3: юнит-тесты bench-ветки FileSaver — auto-save в tmp без
// диалога при env HL_BENCH=1 (узаконенный test-hook как канал __bench/seed 062).
// Матрица:
//  - гард benchAutoSaveEnabled (§14): без HL_BENCH=1 — false; с флагом и не
//    packaged — true; в packaged-эмуляции — false даже с флагом (двойная защита,
//    прецедент benchChannelsEnabled);
//  - savePdf в bench-режиме (§20 AC3): файл записан в <HL_TEST_USER_DATA>/bench-saves,
//    байты PDF на диске 1:1 (бинарный контент воркера 068), ответ {path}; диалог ОС
//    НЕ открывался (showSaveDialog не звался);
//  - без HL_TEST_USER_DATA — fallback в tmp ОС (tmpdir), изоляция сохраняется;
//  - без HL_BENCH — боевой путь: диалог открывается (прецедент report-pdf.int.test.ts,
//    там же — сквозные сценарии отмены/записи поверх мока dialog).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Мок electron — единый модуль на файл; packaged-статус переключается тестом
// (§14: тест-эмуляция packaged, прецедент bench-seed.test.ts).
const electronState = vi.hoisted(() => ({ isPackaged: false }));
const { showSaveDialog } = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return electronState.isPackaged;
    },
  },
  dialog: { showSaveDialog },
}));

import { HL_BENCH_ENV } from '../ipc/handlers/bench-seed.js';
import { BENCH_SAVES_DIRNAME, benchAutoSaveEnabled, ElectronFileSaver } from './file-saver.js';

const BENCH_USER_DATA = join(tmpdir(), `hl-file-saver-test-${process.pid.toString(36)}`);

afterEach(() => {
  vi.unstubAllEnvs();
  electronState.isPackaged = false;
  showSaveDialog.mockReset();
  rmSync(BENCH_USER_DATA, { recursive: true, force: true });
});

describe('benchAutoSaveEnabled — гард bench-ветки (§14)', () => {
  it('без HL_BENCH=1 ветка выключена', () => {
    expect(benchAutoSaveEnabled({}, false)).toBe(false);
    expect(benchAutoSaveEnabled({ [HL_BENCH_ENV]: '0' }, false)).toBe(false);
    expect(benchAutoSaveEnabled({ [HL_BENCH_ENV]: '' }, false)).toBe(false);
  });

  it('HL_BENCH=1 и не packaged — включена', () => {
    expect(benchAutoSaveEnabled({ [HL_BENCH_ENV]: '1' }, false)).toBe(true);
  });

  it('в packaged-режиме env игнорируется — двойная защита (тест-эмуляция isPackaged)', () => {
    expect(benchAutoSaveEnabled({ [HL_BENCH_ENV]: '1' }, true)).toBe(false);
  });
});

describe('ElectronFileSaver.savePdf — bench-ветка auto-save (§5/§20 AC3)', () => {
  it('HL_BENCH=1: файл в <HL_TEST_USER_DATA>/bench-saves, байты 1:1, диалог не открывался', async () => {
    mkdirSync(BENCH_USER_DATA, { recursive: true });
    vi.stubEnv(HL_BENCH_ENV, '1');
    vi.stubEnv('HL_TEST_USER_DATA', BENCH_USER_DATA);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff]);

    const saved = await new ElectronFileSaver().savePdf('bench-report.pdf', pdf);

    if (!('path' in saved)) {
      throw new Error('ожидался {path}, получен canceled');
    }
    const expected = join(BENCH_USER_DATA, BENCH_SAVES_DIRNAME, 'bench-report.pdf');
    expect(saved.path).toBe(expected);
    // Байты 1:1 (Buffer vs Uint8Array — по содержимому, .equals).
    expect(readFileSync(expected).equals(pdf)).toBe(true);
    // §20 AC3: диалог не открывался — авто-режим пишет без вопросов.
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('HL_BENCH=1 без HL_TEST_USER_DATA — fallback в tmpdir ОС (изоляция сохраняется)', async () => {
    vi.stubEnv(HL_BENCH_ENV, '1');
    vi.stubEnv('HL_TEST_USER_DATA', undefined);

    const saved = await new ElectronFileSaver().savePdf('fallback.pdf', new Uint8Array([1, 2, 3]));

    if (!('path' in saved)) {
      throw new Error('ожидался {path}, получен canceled');
    }
    const fallbackRoot = join(tmpdir(), BENCH_SAVES_DIRNAME);
    expect(saved.path.startsWith(fallbackRoot)).toBe(true);
    rmSync(saved.path, { force: true });
  });
});

describe('ElectronFileSaver.savePdf — без HL_BENCH боевой путь сохранён', () => {
  it('диалог открывается (filters PDF, defaultPath), файл пишется по выбранному пути', async () => {
    mkdirSync(BENCH_USER_DATA, { recursive: true });
    const target = join(BENCH_USER_DATA, 'chosen.pdf');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });

    const saved = await new ElectronFileSaver().savePdf('health-log-export.pdf', new Uint8Array([9]));

    expect(saved).toEqual({ path: target });
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'health-log-export.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }),
    );
  });

  it('HL_BENCH=1, но packaged — auto-save игнорируется, диалог открывается (§14)', async () => {
    mkdirSync(BENCH_USER_DATA, { recursive: true });
    electronState.isPackaged = true;
    const target = join(BENCH_USER_DATA, 'packaged.pdf');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    vi.stubEnv(HL_BENCH_ENV, '1');

    const saved = await new ElectronFileSaver().savePdf('packaged.pdf', new Uint8Array([1]));

    expect(saved).toEqual({ path: target });
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
  });
});
