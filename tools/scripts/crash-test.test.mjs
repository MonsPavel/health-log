// Ревью TASK-102 (фикс замечания «--kill-mode с опечаткой молча деградирует к
// idle»): юнит-тесты CLI-парсера и программной валидации killMode. Матрица:
//  - parseCrashCliArgs: пустые аргументы → пустые опции (дефолты — в crashTestRun);
//  - --smoke → пресет {iterations: 1, calibration: 2} (§19), прочие флаги
//    поверх пресета;
//  - --kill-mode принимает ровно idle | in-flight (§8: пара сценариев килла);
//    ОПЕЧАТКА (--kill-mode inflight) — ошибка парсера (usage/exit 2), а не
//    молчаливый idle: демо чувствительности §20-3 не должно проходить впустую;
//  - неизвестный флаг — ошибка;
//  - crashTestRun: программный killMode вне словаря — reject ДО любых шагов
//    прогона (валидация первая — тест не требует dist-сборки).
import { describe, expect, it } from 'vitest';

import { crashTestRun, CRASH_KILL_MODES, parseCrashCliArgs } from './crash-test.mjs';

describe('parseCrashCliArgs — разбор флагов прогона', () => {
  it('без флагов — пустые опции (дефолты применяет crashTestRun)', () => {
    expect(parseCrashCliArgs([])).toEqual({ options: {} });
  });

  it('--smoke → пресет §19 {iterations: 1, calibration: 2}', () => {
    expect(parseCrashCliArgs(['--smoke'])).toEqual({
      options: { iterations: 1, calibration: 2 },
    });
  });

  it('флаги поверх пресета: --smoke --kill-mode in-flight --batch 5000 (демо §20-3)', () => {
    expect(parseCrashCliArgs(['--smoke', '--kill-mode', 'in-flight', '--batch', '5000'])).toEqual({
      options: { iterations: 1, calibration: 2, killMode: 'in-flight', batch: 5000 },
    });
  });

  it('обоим допустимым режимам килла соответствует запись словаря CRASH_KILL_MODES', () => {
    expect(CRASH_KILL_MODES).toEqual(['idle', 'in-flight']);
    expect(parseCrashCliArgs(['--kill-mode', 'idle']).options.killMode).toBe('idle');
    expect(parseCrashCliArgs(['--kill-mode', 'in-flight']).options.killMode).toBe('in-flight');
  });

  it('ОПЕЧАТКА в --kill-mode — ошибка парсера, а не молчаливый idle (ревью TASK-102)', () => {
    const parsed = parseCrashCliArgs(['--kill-mode', 'inflight']);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('inflight');
    expect(parsed.error).toContain('idle|in-flight');
    expect(parsed.options).toBeUndefined();
  });

  it('неизвестный флаг — ошибка с подсказкой', () => {
    const parsed = parseCrashCliArgs(['--nope']);
    expect(parsed.error).toContain('--nope');
    expect(parsed.options).toBeUndefined();
  });
});

describe('crashTestRun — программная валидация killMode (второй рубеж)', () => {
  it('killMode вне словаря — reject ДО шагов прогона (без сборки/запусков)', async () => {
    await expect(crashTestRun({ killMode: 'inflight' })).rejects.toThrow(
      /idle\|in-flight.*inflight|inflight.*idle\|in-flight/s,
    );
    await expect(crashTestRun({ killMode: '' })).rejects.toThrow(/idle\|in-flight/);
  });
});
