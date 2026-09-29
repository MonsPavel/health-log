/**
 * TASK-049 §19/§20: тесты FlagsService (renderer) — типизированный реестр флагов
 * поверх prefs (арх. 09 §4: defaults в коде, overrides — в prefs):
 *  - реестр: advancedMode → {default: false (= простой режим, §13), labelKey §17};
 *  - useFlags: чистые prefs → default; prefs.advancedMode=true → true (§12: флаги —
 *    производные prefs, тот же кэш-ключ);
 *  - useSetFlag: setFlag('advancedMode', v) → prefs/set {patch:{advancedMode:v}}
 *    (§7: маппинг 1:1), optimistic-кэш обновлён;
 *  - тип-тесты: неизвестный флаг — ошибка компиляции (AC-4); добавление нового
 *    флага (P4/P5: reports.aiSection, §5) не ломает существующих потребителей.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Prefs } from '@hl/contracts';

import { FLAGS, useFlags, useSetFlag, type FlagDefinition, type FlagName } from './flags';

/** Дефолтный документ для моков ответов prefs/get (значения §8 схемы TASK-047). */
const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
  // TASK-074: состояние задач планировщика — новое поле документа (дефолт схемы).
  jobState: { jobs: {}, shown: {} },
};

const OK_ENVELOPE = (data: unknown) => ({ v: 1, ok: true, data });

let invoke: ReturnType<typeof vi.fn>;

function renderFlags() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => ({ flags: useFlags(), setFlag: useSetFlag() }), { wrapper });
}

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(OK_ENVELOPE(DEFAULT_PREFS));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
  localStorage.clear();
});

describe('FLAGS — реестр (§4/§5/§13)', () => {
  it('advancedMode: default false (= простой режим первого запуска) и labelKey из §17', () => {
    expect(FLAGS.advancedMode).toEqual({ default: false, labelKey: 'settings.simpleMode' });
  });
});

describe('useFlags — чтение (§12: производные prefs, тот же кэш-ключ)', () => {
  it('чистые prefs (дефолты): advancedMode=false — простой режим (§13, AC-1)', async () => {
    const { result } = renderFlags();

    await waitFor(() => expect(result.current.flags).toEqual({ advancedMode: false }));
    expect(invoke).toHaveBeenCalledWith('prefs/get', {});
  });

  it('prefs.advancedMode=true → флаг true (документ prefs — источник значения)', async () => {
    invoke.mockResolvedValue(OK_ENVELOPE({ ...DEFAULT_PREFS, advancedMode: true }));

    const { result } = renderFlags();

    await waitFor(() => expect(result.current.flags).toEqual({ advancedMode: true }));
  });
});

describe('useSetFlag — запись (§7: маппинг 1:1 — имя флага = поле prefs)', () => {
  it("setFlag('advancedMode', true) → prefs/set {patch:{advancedMode:true}}; флаг перечитан", async () => {
    const { result } = renderFlags();
    await waitFor(() => expect(result.current.flags).toEqual({ advancedMode: false }));

    invoke.mockResolvedValueOnce(OK_ENVELOPE({ ...DEFAULT_PREFS, advancedMode: true }));
    act(() => {
      result.current.setFlag('advancedMode', true);
    });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { advancedMode: true } }),
    );
    await waitFor(() => expect(result.current.flags).toEqual({ advancedMode: true }));
  });

  it("setFlag('advancedMode', false) → prefs/set {patch:{advancedMode:false}}", async () => {
    invoke.mockResolvedValue(OK_ENVELOPE({ ...DEFAULT_PREFS, advancedMode: true }));
    const { result } = renderFlags();
    await waitFor(() => expect(result.current.flags).toEqual({ advancedMode: true }));

    invoke.mockResolvedValueOnce(OK_ENVELOPE({ ...DEFAULT_PREFS, advancedMode: false }));
    act(() => {
      result.current.setFlag('advancedMode', false);
    });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { advancedMode: false } }),
    );
  });
});

describe('типы реестра (AC-4, §19)', () => {
  it('сигнатуры потребителей выведены из реестра — Record по FlagName, без ручных списков', () => {
    expectTypeOf(FLAGS).toEqualTypeOf<Record<FlagName, FlagDefinition>>();
    expectTypeOf(useFlags).returns.toEqualTypeOf<Record<FlagName, boolean>>();
    expectTypeOf(useSetFlag).returns.toEqualTypeOf<(name: FlagName, value: boolean) => void>();
  });

  it('неизвестный флаг — ошибка компиляции (AC-4)', () => {
    const getFlag = (name: FlagName): FlagDefinition => FLAGS[name];
    const readUnknown = (): FlagDefinition =>
      // @ts-expect-error FlagName не содержит ai.chat — флаг войдёт в P4/P5 (§5).
      // Прецедент channels.test.ts: подавление на аргументе-литерале (§22: только тип).
      getFlag('ai.chat');
    // Не выполняется (только тип-проверка).
    expectTypeOf(readUnknown).returns.toEqualTypeOf<FlagDefinition>();
  });

  it('добавление нового флага (§5: reports.aiSection в P4/P5) не ломает существующих (§19)', () => {
    type ExtendedName = FlagName | 'reports.aiSection';
    // Расширение реестра компилируется той же формой записи (spread текущего).
    const extended: Record<ExtendedName, FlagDefinition> = {
      ...FLAGS,
      'reports.aiSection': { default: false, labelKey: 'settings.reportsAiSection' },
    };
    // Обобщённый потребитель работает и с текущим, и с расширенным реестром.
    const allDefaultsFalse = <N extends string>(registry: Record<N, FlagDefinition>): boolean =>
      (Object.keys(registry) as N[]).every((name) => registry[name].default === false);

    expect(allDefaultsFalse(FLAGS)).toBe(true);
    expect(allDefaultsFalse(extended)).toBe(true);
  });
});
