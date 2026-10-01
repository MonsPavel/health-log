/**
 * TASK-047 §11/§19: тесты zod-схем каналов `prefs/get|set` и документа Prefs.
 *
 * Матрица:
 *  - PREFS_SCHEMA парсит полный документ (значения-enum по §5);
 *  - мусор отклоняется: неизвестная тема/масштаб/формат, не-boolean, чужое поле
 *    (strict — §14);
 *  - PREFS_PATCH_SCHEMA: пустой patch валиден; неизвестное поле ОТБРАСЫВАЕТСЯ, а
 *    не ошибка (§7 strict-merge: «отброшено, валидные применены» — AC5); неверный
 *    ТИП значения → ошибка (VALIDATION/FAILED каркаса, §11);
 *  - запрос get — строго пустой объект; ответ — полный документ.
 */
import { describe, expect, it } from 'vitest';

import {
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_PATCH_SCHEMA,
  PREFS_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
} from './schemas.js';

const VALID_PREFS = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false, modelsDownload: false },
  jobState: { jobs: {}, shown: {} },
  // TASK-088 §5: includeNotes — тумблер заметок превью (дефолт false, zod).
  aiSettings: { dismissed: false, includeNotes: false },
  // TASK-094 §5: порог автоблока по простою, минуты (0 — выкл; дефолт 5).
  autoLockMin: 5,
} as const;

describe('PREFS_SCHEMA — документ настроек (§5)', () => {
  it('парсит полный валидный документ', () => {
    expect(PREFS_SCHEMA.parse(VALID_PREFS)).toEqual(VALID_PREFS);
  });

  it('zod-дефолты: пустой/усечённый документ парсится с заполнением недостающего (§22)', () => {
    expect(PREFS_SCHEMA.parse({})).toEqual(VALID_PREFS);
    expect(PREFS_SCHEMA.parse({ theme: 'dark' })).toEqual({ ...VALID_PREFS, theme: 'dark' });
  });

  it('все значения-enum принимаются по списку §5', () => {
    for (const theme of ['system', 'light', 'dark']) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, theme })).toMatchObject({ theme });
    }
    for (const textScale of ['100', '112.5', '125']) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, textScale })).toMatchObject({ textScale });
    }
    for (const dateFormat of ['auto', 'dmy', 'mdy']) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, dateFormat })).toMatchObject({ dateFormat });
    }
  });

  it('мусор отклоняется: чужая тема, чужой масштаб, не-boolean, лишнее поле (strict)', () => {
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, theme: 'sepia' }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, textScale: 150 }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, dateFormat: 'ymd' }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, advancedMode: 'yes' }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, stranger: 1 }).success).toBe(false);
    expect(
      PREFS_SCHEMA.safeParse({ ...VALID_PREFS, netConsents: { updatesCheck: 'yes' } }).success,
    ).toBe(false);
  });
});

describe('PREFS_SCHEMA — autoLockMin (TASK-094 §5: порог автоблока)', () => {
  it('допустимые значения 5|15|60 и 0 (выкл); дефолт 5', () => {
    for (const autoLockMin of [0, 5, 15, 60]) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, autoLockMin })).toMatchObject({ autoLockMin });
    }
    expect(PREFS_SCHEMA.parse({}).autoLockMin).toBe(5);
  });

  it('прочие числа/типы отклоняются', () => {
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, autoLockMin: 3 }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, autoLockMin: -1 }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, autoLockMin: '5' }).success).toBe(false);
  });
});

describe('PREFS_SCHEMA — jobState (TASK-074 §5: состояние задач JobScheduler)', () => {
  it('дефолт: пустой jobState {jobs: {}, shown: {}} без метаданных копии', () => {
    expect(PREFS_SCHEMA.parse({}).jobState).toEqual({ jobs: {}, shown: {} });
  });

  it('парсит полный jobState: lastBackup {path, at}; jobs/shown — имя/kind → utcMs', () => {
    const jobState = {
      lastBackup: { path: String.raw`C:\users\backup.hlbackup`, at: 1_700_000_000_000 },
      jobs: { 'backup.reminder': 1_700_000_000_000 },
      shown: { 'backup-reminder': 1_700_000_000_000 },
    };
    expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, jobState }).jobState).toEqual(jobState);
  });

  it('мусор отклоняется (strict): чужое поле, неверная форма lastBackup, не-число в jobs', () => {
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, jobState: { stranger: 1 } }).success).toBe(
      false,
    );
    expect(
      PREFS_SCHEMA.safeParse({ ...VALID_PREFS, jobState: { lastBackup: { path: 1 } } }).success,
    ).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, jobState: { jobs: { j: 'x' } } }).success).toBe(
      false,
    );
  });
});

describe('PREFS_SCHEMA — aiSettings (TASK-081 §5: выбор модели и «настроить позже»)', () => {
  it('дефолт: aiSettings {dismissed: false, includeNotes: false} без modelId (модель не выбрана)', () => {
    expect(PREFS_SCHEMA.parse({}).aiSettings).toEqual({ dismissed: false, includeNotes: false });
  });

  it('парсит полный aiSettings: modelId + dismissed=true («настроить позже»)', () => {
    expect(
      PREFS_SCHEMA.parse({ ...VALID_PREFS, aiSettings: { modelId: 'dev-ru', dismissed: true } })
        .aiSettings,
    ).toEqual({
      modelId: 'dev-ru',
      dismissed: true,
      includeNotes: false,
    });
  });

  it('мусор отклоняется (strict): пустой modelId, чужое поле, не-boolean dismissed', () => {
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, aiSettings: { modelId: '' } }).success).toBe(
      false,
    );
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, aiSettings: { stranger: 1 } }).success).toBe(
      false,
    );
    expect(
      PREFS_SCHEMA.safeParse({ ...VALID_PREFS, aiSettings: { dismissed: 'yes' } }).success,
    ).toBe(false);
  });
});

describe('PREFS_SCHEMA — aiSettings.includeNotes (TASK-088 §5: тумблер превью персистентен)', () => {
  it('дефолт: includeNotes false — заметки в контекст ТОЛЬКО по явной опции (FR-5.5/§14)', () => {
    expect(PREFS_SCHEMA.parse({}).aiSettings).toMatchObject({ includeNotes: false });
  });

  it('парсит includeNotes: true — выбор пользователя переживает перезапуск (prefs)', () => {
    expect(
      PREFS_SCHEMA.parse({ ...VALID_PREFS, aiSettings: { dismissed: false, includeNotes: true } })
        .aiSettings,
    ).toMatchObject({ includeNotes: true });
  });

  it('мусор отклоняется (strict): не-boolean includeNotes', () => {
    expect(
      PREFS_SCHEMA.safeParse({ ...VALID_PREFS, aiSettings: { includeNotes: 'yes' } }).success,
    ).toBe(false);
  });
});

describe('PREFS_PATCH_SCHEMA — patch set (§7/§11)', () => {
  it('пустой patch валиден (частичное обновление)', () => {
    expect(PREFS_PATCH_SCHEMA.parse({})).toEqual({});
  });

  it('неизвестное поле отброшено, валидные применены (AC5 strict-merge)', () => {
    const parsed = PREFS_PATCH_SCHEMA.parse({ theme: 'dark', hackerField: true });
    expect(parsed).toEqual({ theme: 'dark' });
  });

  it('неверный ТИП значения — ошибка (VALIDATION/FAILED каркаса, §11)', () => {
    expect(PREFS_PATCH_SCHEMA.safeParse({ theme: 123 }).success).toBe(false);
    expect(PREFS_PATCH_SCHEMA.safeParse({ textScale: '150' }).success).toBe(false);
    expect(PREFS_PATCH_SCHEMA.safeParse({ advancedMode: null }).success).toBe(false);
  });

  it('вложенные netConsents — объектом целиком (без deep-merge: один consent, §5)', () => {
    expect(PREFS_PATCH_SCHEMA.parse({ netConsents: { updatesCheck: true } })).toEqual({
      netConsents: { updatesCheck: true, modelsDownload: false },
    });
    expect(PREFS_PATCH_SCHEMA.safeParse({ netConsents: {} }).success).toBe(false);
  });

  it('netConsents — обратная совместимость (TASK-075 §5): старый документ без modelsDownload парсится с дефолтом false, выданное updatesCheck сохранено', () => {
    expect(PREFS_SCHEMA.parse({ netConsents: { updatesCheck: true } }).netConsents).toEqual({
      updatesCheck: true,
      modelsDownload: false,
    });
    expect(
      PREFS_PATCH_SCHEMA.parse({ netConsents: { updatesCheck: true, modelsDownload: true } }),
    ).toEqual({
      netConsents: { updatesCheck: true, modelsDownload: true },
    });
  });

  it('jobState — объектом целиком (без deep-merge, семантика netConsents; TASK-074 §5/§12)', () => {
    expect(PREFS_PATCH_SCHEMA.parse({ jobState: { shown: { 'backup-reminder': 1 } } })).toEqual({
      jobState: { shown: { 'backup-reminder': 1 }, jobs: {} },
    });
    expect(PREFS_PATCH_SCHEMA.safeParse({ jobState: { stranger: 1 } }).success).toBe(false);
    expect(PREFS_PATCH_SCHEMA.safeParse({ jobState: { jobs: 5 } }).success).toBe(false);
  });

  it('aiSettings — объектом целиком (без deep-merge, семантика netConsents; TASK-081 §5: select пишет {modelId}, «позже» — {dismissed})', () => {
    expect(PREFS_PATCH_SCHEMA.parse({ aiSettings: { modelId: 'dev-ru' } })).toEqual({
      aiSettings: { modelId: 'dev-ru', dismissed: false, includeNotes: false },
    });
    expect(PREFS_PATCH_SCHEMA.parse({ aiSettings: { dismissed: true } })).toEqual({
      aiSettings: { dismissed: true, includeNotes: false },
    });
    expect(PREFS_PATCH_SCHEMA.safeParse({ aiSettings: { modelId: 5 } }).success).toBe(false);
  });

  it('autoLockMin — patch принимается (5|15|60|0), неверное значение — ошибка (TASK-094 §5)', () => {
    expect(PREFS_PATCH_SCHEMA.parse({ autoLockMin: 15 })).toEqual({ autoLockMin: 15 });
    expect(PREFS_PATCH_SCHEMA.parse({ autoLockMin: 0 })).toEqual({ autoLockMin: 0 });
    expect(PREFS_PATCH_SCHEMA.safeParse({ autoLockMin: 30 }).success).toBe(false);
  });
});

describe('схемы каналов prefs/get|set (§11)', () => {
  it('prefs/get: запрос — строго пустой объект', () => {
    expect(PREFS_GET_REQUEST_SCHEMA.parse({})).toEqual({});
    expect(PREFS_GET_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('prefs/set: запрос — {patch}, строго; ответ — полный документ', () => {
    const request = PREFS_SET_REQUEST_SCHEMA.parse({ patch: { theme: 'dark' } });
    expect(request.patch).toEqual({ theme: 'dark' });
    expect(PREFS_SET_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(PREFS_SET_REQUEST_SCHEMA.safeParse({ patch: { theme: 'dark' }, extra: 1 }).success).toBe(
      false,
    );

    expect(PREFS_SCHEMA.parse(VALID_PREFS)).toEqual(VALID_PREFS);
  });
});
