// TASK-017 §19: юниты на FixedClock — happy-path create/edit, каждый инвариант отдельным
// кейсом с точным кодом ошибки, иммутабельность edit (deep-freeze), trim-заметки,
// равенство now и будущее на +1 мс, uuid v7 (regex версии). Property fast-check —
// граница длины заметки (≤500 ok, >500 NOTE_TOO_LONG). Моки не нужны — чистый домен
// с инъекцией Clock (NFR-10).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FixedClock, isErr, isOk, unsafeUnwrap } from '@hl/kernel';

import { BpMeasurement } from './bp-measurement.js';
import { BP_LIMITS, NOTE_MAX_LENGTH } from './constants.js';
import type {
  CreateMeasurementCommand,
  EditMeasurementCommand,
} from './measurement-commands.js';

/** Фиксированное «сейчас» и пояс (UTC+3) — детерминизм NFR-10. */
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00:00Z
const NOW_LATER_MS = NOW_MS + 3_600_000;
const TZ = 180;

const clockNow = new FixedClock(NOW_MS, TZ);
const clockLater = new FixedClock(NOW_LATER_MS, TZ);

/** Валидная команда create: измерение минуту назад, без пульса и заметки. */
const createCmd = (overrides: Partial<CreateMeasurementCommand> = {}): CreateMeasurementCommand => ({
  profileId: 'profile-1',
  sys: 120,
  dia: 80,
  irregularPulse: false,
  arm: 'left',
  takenAt: { utcMs: NOW_MS - 60_000, tzOffsetMin: TZ },
  ...overrides,
});

/** Команда edit с теми же измеримыми полями, что и createCmd(). */
const editCmd = (overrides: Partial<EditMeasurementCommand> = {}): EditMeasurementCommand => ({
  sys: 120,
  dia: 80,
  irregularPulse: false,
  arm: 'left',
  takenAt: { utcMs: NOW_MS - 60_000, tzOffsetMin: TZ },
  ...overrides,
});

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('BpMeasurement.create — happy path (§19)', () => {
  it('валидные поля → ok со всеми полями агрегата (§7)', () => {
    const result = BpMeasurement.create(
      createCmd({ pulse: 70, note: '  после бега  ', irregularPulse: true, arm: 'right' }),
      clockNow,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const m = result.value;
      expect(m.id).toMatch(UUID_V7_PATTERN);
      expect(m.profileId).toBe('profile-1');
      expect(m.bp.sys).toBe(120);
      expect(m.bp.dia).toBe(80);
      expect(m.pulse).toBe(70);
      expect(m.irregularPulse).toBe(true);
      expect(m.arm).toBe('right');
      expect(m.note).toBe('после бега');
      expect(m.takenAt).toEqual({ utcMs: NOW_MS - 60_000, tzOffsetMin: TZ });
      expect(m.source).toBe('manual');
      expect(m.createdAtUtc).toBe(NOW_MS);
      expect(m.updatedAtUtc).toBe(NOW_MS);
    }
  });

  it('id — uuid v7: версия (3-я группа) = 7, вариант (4-я) = 8/9/a/b (§20)', () => {
    const m = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));

    expect(m.id).toMatch(UUID_V7_PATTERN);
  });

  it('два create → разные id (уникальность идентичности)', () => {
    const a = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));
    const b = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));

    expect(a.id).not.toBe(b.id);
  });

  it('pulse undefined → валидно, поле undefined (§20)', () => {
    const m = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));

    expect(m.pulse).toBeUndefined();
  });

  it('заметка не передана → note undefined (§7)', () => {
    const m = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));

    expect(m.note).toBeUndefined();
  });

  it('ввод задним числом: takenAt за 30 дней до now → ok (US-3, §3)', () => {
    const result = BpMeasurement.create(
      createCmd({ takenAt: { utcMs: NOW_MS - 30 * 86_400_000, tzOffsetMin: TZ } }),
      clockNow,
    );

    expect(isOk(result)).toBe(true);
  });
});

describe('BpMeasurement.create — инвариант «takenAt ≤ now» (§13)', () => {
  it('takenAt = clock.nowMs() → ok: равенство «сейчас» валидно, допуск 0 мс (§20)', () => {
    const result = BpMeasurement.create(createCmd({ takenAt: { utcMs: NOW_MS, tzOffsetMin: TZ } }), clockNow);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.takenAt.utcMs).toBe(NOW_MS);
    }
  });

  it('takenAt = clock.nowMs() + 1 → err FUTURE_TIME (§20)', () => {
    const result = BpMeasurement.create(
      createCmd({ takenAt: { utcMs: NOW_MS + 1, tzOffsetMin: TZ } }),
      clockNow,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/FUTURE_TIME');
      expect(result.error.messageKey).toBe('errors.MEASUREMENT_FUTURE_TIME');
    }
  });
});

describe('BpMeasurement.create — заметка (§13)', () => {
  it(`ровно ${NOTE_MAX_LENGTH} символов → ok (§20)`, () => {
    const note = 'а'.repeat(NOTE_MAX_LENGTH);
    const result = BpMeasurement.create(createCmd({ note }), clockNow);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.note).toBe(note);
    }
  });

  it(`${NOTE_MAX_LENGTH + 1} символ → err NOTE_TOO_LONG params {max: 500} (§20)`, () => {
    const result = BpMeasurement.create(createCmd({ note: 'а'.repeat(NOTE_MAX_LENGTH + 1) }), clockNow);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/NOTE_TOO_LONG');
      expect(result.error.params).toEqual({ max: NOTE_MAX_LENGTH });
      expect(result.error.messageKey).toBe('errors.MEASUREMENT_NOTE_TOO_LONG');
    }
  });

  it('whitespace-заметка «   » → note undefined (§13)', () => {
    const m = unsafeUnwrap(BpMeasurement.create(createCmd({ note: '   ' }), clockNow));

    expect(m.note).toBeUndefined();
  });

  it('whitespace-заметка любой длины после trim пуста → ok, note undefined (§13, trim раньше длины)', () => {
    const m = unsafeUnwrap(BpMeasurement.create(createCmd({ note: ' '.repeat(600) }), clockNow));

    expect(m.note).toBeUndefined();
  });

  it('заметка с краями-пробелами сохраняется trim-нутой (§13)', () => {
    const m = unsafeUnwrap(BpMeasurement.create(createCmd({ note: '  пульс ровный  ' }), clockNow));

    expect(m.note).toBe('пульс ровный');
  });
});

describe('BpMeasurement.create — делегирование VO и порядок валидации (§7)', () => {
  it('sys ≤ dia → err SYS_LE_DIA от BloodPressure (§7)', () => {
    const result = BpMeasurement.create(createCmd({ sys: 80, dia: 120 }), clockNow);

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/SYS_LE_DIA');
  });

  it('pulse вне [20, 300] → err INVALID_RANGE по полю pulse (§7)', () => {
    const result = BpMeasurement.create(
      createCmd({ pulse: BP_LIMITS.PULSE_MAX + 1 }),
      clockNow,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
      expect(result.error.params).toEqual({
        field: 'pulse',
        value: BP_LIMITS.PULSE_MAX + 1,
        min: BP_LIMITS.PULSE_MIN,
        max: BP_LIMITS.PULSE_MAX,
      });
    }
  });

  it('порядок: невалидное давление + длинная заметка + будущее время → BP раньше всех (§7)', () => {
    const result = BpMeasurement.create(
      createCmd({
        sys: BP_LIMITS.SYS_MAX + 1,
        note: 'а'.repeat(NOTE_MAX_LENGTH + 1),
        takenAt: { utcMs: NOW_MS + 1, tzOffsetMin: TZ },
      }),
      clockNow,
    );

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
  });

  it('порядок: невалидный пульс + будущее время → Pulse раньше FUTURE_TIME (§7)', () => {
    const result = BpMeasurement.create(
      createCmd({ pulse: 10, takenAt: { utcMs: NOW_MS + 1, tzOffsetMin: TZ } }),
      clockNow,
    );

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/INVALID_RANGE');
  });

  it('порядок: длинная заметка + будущее время → NOTE_TOO_LONG раньше FUTURE_TIME (§7)', () => {
    const result = BpMeasurement.create(
      createCmd({
        note: 'а'.repeat(NOTE_MAX_LENGTH + 1),
        takenAt: { utcMs: NOW_MS + 1, tzOffsetMin: TZ },
      }),
      clockNow,
    );

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/NOTE_TOO_LONG');
  });
});

describe('BpMeasurement.edit — пересборка копии (§7)', () => {
  it('edit обновляет измеримые поля, id/profileId/source/createdAtUtc наследуются (§7)', () => {
    const existing = unsafeUnwrap(
      BpMeasurement.create(
        createCmd({ pulse: 70, note: 'было', irregularPulse: false, arm: 'left' }),
        clockNow,
      ),
    );
    const result = BpMeasurement.edit(
      existing,
      editCmd({ sys: 130, dia: 85, pulse: undefined, note: ' стало ', irregularPulse: true, arm: 'right' }),
      clockLater,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const m = result.value;
      expect(m.id).toBe(existing.id);
      expect(m.profileId).toBe(existing.profileId);
      expect(m.source).toBe('manual');
      expect(m.bp.sys).toBe(130);
      expect(m.bp.dia).toBe(85);
      expect(m.pulse).toBeUndefined();
      expect(m.note).toBe('стало');
      expect(m.irregularPulse).toBe(true);
      expect(m.arm).toBe('right');
      expect(m.createdAtUtc).toBe(NOW_MS);
      expect(m.updatedAtUtc).toBe(NOW_LATER_MS);
    }
  });

  it('edit не мутирует existing: deep-freeze, новый объект со старыми полями (§20)', () => {
    const existing = unsafeUnwrap(
      BpMeasurement.create(createCmd({ pulse: 70, note: 'до правки' }), clockNow),
    );
    const snapshot = {
      id: existing.id,
      sys: existing.bp.sys,
      dia: existing.bp.dia,
      pulse: existing.pulse,
      note: existing.note,
      takenAt: { ...existing.takenAt },
      updatedAtUtc: existing.updatedAtUtc,
    };
    // Глубокая заморозка: сам агрегат, VO bp и Instant takenAt.
    Object.freeze(existing);
    Object.freeze(existing.bp);
    Object.freeze(existing.takenAt);

    const result = BpMeasurement.edit(
      existing,
      editCmd({ sys: 140, dia: 90, note: 'после правки' }),
      clockLater,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const m = result.value;
      expect(m).not.toBe(existing);
      // existing не изменился ни в одном поле
      expect(existing.id).toBe(snapshot.id);
      expect(existing.bp.sys).toBe(snapshot.sys);
      expect(existing.bp.dia).toBe(snapshot.dia);
      expect(existing.pulse).toBe(snapshot.pulse);
      expect(existing.note).toBe(snapshot.note);
      expect(existing.takenAt).toEqual(snapshot.takenAt);
      expect(existing.updatedAtUtc).toBe(snapshot.updatedAtUtc);
      // правка живёт в новой копии
      expect(m.bp.sys).toBe(140);
      expect(m.bp.dia).toBe(90);
      expect(m.note).toBe('после правки');
    }
  });

  it('edit снова делает агрегат валидным: правка takenAt в прошлое → ok (US-3)', () => {
    const existing = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));
    const result = BpMeasurement.edit(
      existing,
      editCmd({ takenAt: { utcMs: NOW_LATER_MS - 86_400_000, tzOffsetMin: TZ } }),
      clockLater,
    );

    expect(isOk(result)).toBe(true);
  });
});

describe('BpMeasurement.edit — инварианты пере проверяются (§7)', () => {
  it('edit с takenAt = now()+1 → err FUTURE_TIME (§13)', () => {
    const existing = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));
    const result = BpMeasurement.edit(
      existing,
      editCmd({ takenAt: { utcMs: NOW_LATER_MS + 1, tzOffsetMin: TZ } }),
      clockLater,
    );

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/FUTURE_TIME');
  });

  it('edit с заметкой 501 символ → err NOTE_TOO_LONG params {max: 500} (§13)', () => {
    const existing = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));
    const result = BpMeasurement.edit(
      existing,
      editCmd({ note: 'а'.repeat(NOTE_MAX_LENGTH + 1) }),
      clockLater,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MEASUREMENT/NOTE_TOO_LONG');
      expect(result.error.params).toEqual({ max: NOTE_MAX_LENGTH });
    }
  });

  it('edit с sys ≤ dia → err SYS_LE_DIA (§7)', () => {
    const existing = unsafeUnwrap(BpMeasurement.create(createCmd(), clockNow));
    const result = BpMeasurement.edit(existing, editCmd({ sys: 70, dia: 90 }), clockLater);

    expect(isErr(result) && result.error.code).toBe('MEASUREMENT/SYS_LE_DIA');
  });
});

describe('Property-тест заметки (fast-check, §19)', () => {
  it('длина ≤ 500 (после trim) → ok; > 500 → NOTE_TOO_LONG с params {max: 500}', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 700 }), (length) => {
        const note = 'а'.repeat(length); // без пробелов — trim не меняет длину
        const result = BpMeasurement.create(createCmd({ note }), clockNow);

        if (note.length <= NOTE_MAX_LENGTH) {
          expect(isOk(result)).toBe(true);
          if (isOk(result)) {
            expect(result.value.note).toBe(note);
          }
        } else {
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('MEASUREMENT/NOTE_TOO_LONG');
            expect(result.error.params).toEqual({ max: NOTE_MAX_LENGTH });
          }
        }
      }),
    );
  });
});
