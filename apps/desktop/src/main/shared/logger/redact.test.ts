/**
 * TASK-010 §7/§14/§19: тест-контракт редакции PHI. Контракт (§7): PHI-поля — sys, dia,
 * pulse, note, content, question, answer, measurements (+ singular measurement из
 * redact-путей §5) на ЛЮБОЙ глубине вложенности; значения заменяются на '[redacted]',
 * разрешённые соседи (id, длительности, коды) остаются. Редакция — по ключу, а не по
 * содержимому строки (§13: правило вызова — не логировать пользовательский ввод —
 * первично; redact — защита в глубину для известных ключей).
 */
import { describe, expect, it } from 'vitest';

import { MAX_REDACT_DEPTH, PHI_CENSOR, PHI_KEYS, PHI_REDACT_PATHS, redactPhi } from './redact.js';

/** Строковое представление выхода — так, как его увидит лог-файл (§20: grep по значениям). */
function outJson(value: unknown): string {
  return JSON.stringify(value);
}

describe('redactPhi — контракт §19 (фикстура измерения)', () => {
  it('значения PHI-ключей цензурены, разрешённые соседи остаются', () => {
    const out = redactPhi({ measurement: { sys: 125, note: 'болит голова' }, durationMs: 12 });

    expect(out).toEqual({ measurement: PHI_CENSOR, durationMs: 12 });
    // §20: ни одно PHI-значение фикстуры не найдено в выходе
    expect(outJson(out)).not.toContain('125');
    expect(outJson(out)).not.toContain('болит');
  });

  it('вход не мутируется — редакция возвращает новый объект', () => {
    const input = { measurement: { sys: 125, dia: 82 }, durationMs: 12 };

    redactPhi(input);

    expect(input).toEqual({ measurement: { sys: 125, dia: 82 }, durationMs: 12 });
  });
});

describe('redactPhi — произвольная глубина (§14: pino redact не покрывает глубину)', () => {
  it('PHI-ключи цензурены на любом уровне вложенности, структура вокруг сохраняется', () => {
    const out = redactPhi({ request: { id: 7, item: { pulse: 80, op: 'read' } } });

    expect(out).toEqual({ request: { id: 7, item: { pulse: PHI_CENSOR, op: 'read' } } });
  });

  it('массивы обходятся: элементы с PHI-ключами цензурены, остальные остаются', () => {
    const out = redactPhi({ items: [{ note: 'заметка' }, { ok: 1 }], total: 2 });

    expect(out).toEqual({ items: [{ note: PHI_CENSOR }, { ok: 1 }], total: 2 });
    expect(outJson(out)).not.toContain('заметка');
  });

  it('measurements (массив измерений) — PHI-ключ: цензурируется целиком (§7)', () => {
    const out = redactPhi({ measurements: [{ sys: 120 }, { dia: 80 }], count: 2 });

    expect(out).toEqual({ measurements: PHI_CENSOR, count: 2 });
  });

  it('question/answer (чат AI) — PHI-ключи на любом уровне (§7)', () => {
    const out = redactPhi({ chat: { question: 'что?', answer: 'это' }, model: 'local' });

    expect(out).toEqual({ chat: { question: PHI_CENSOR, answer: PHI_CENSOR }, model: 'local' });
  });
});

describe('redactPhi — точное совпадение ключа (§7: «пути без имени пользователя разрешены»)', () => {
  it('system/syslog не путаются с sys; остальные ключи не цензурятся', () => {
    const out = redactPhi({ system: 'ok', syslog: 1, sys: 125 });

    expect(out).toEqual({ system: 'ok', syslog: 1, sys: PHI_CENSOR });
  });

  it('строки вне PHI-ключей не цензурятся — редакция ключевая, не содержательная', () => {
    const out = redactPhi({ message: 'болит голова', code: 'MEASUREMENT/INVALID' });

    expect(out).toEqual({ message: 'болит голова', code: 'MEASUREMENT/INVALID' });
  });

  it('null и примитивы проходят как есть', () => {
    expect(redactPhi(null)).toBeNull();
    expect(redactPhi('текст')).toBe('текст');
    expect(redactPhi(42)).toBe(42);
    expect(redactPhi(true)).toBe(true);
  });

  it('Error-экземпляры — листья: проходят как есть (pino зовёт formatters.log ДО сериализатора — опустошённый Error лишит err-сериализатор стека)', () => {
    const error = new Error('boom', { cause: { note: 'x' } });
    expect(redactPhi({ err: error })['err']).toBe(error);
  });
});

describe('redactPhi — отказобезопасность (§14)', () => {
  it('циклические ссылки — цензура ссылки вместо бесконечной рекурсии', () => {
    const node: { name: string; self?: unknown } = { name: 'a' };
    node.self = node;

    const out = redactPhi(node) as { name: string; self: unknown };

    expect(out.name).toBe('a');
    expect(outJson(out)).not.toContain('точно-не-должно-упасть');
    expect(out.self).toBe(PHI_CENSOR);
  });

  it(`глубже ${MAX_REDACT_DEPTH} уровней — цензура хвоста (неизвестное = цензуренное)`, () => {
    let deep: unknown = { sys: 125 };
    for (let i = 0; i <= MAX_REDACT_DEPTH; i += 1) {
      deep = { wrap: deep };
    }

    expect(outJson(redactPhi(deep))).not.toContain('125');
  });

  it('уровень ниже предела не цензурится — предел не делает логгер бесполезным', () => {
    let deep: unknown = { pulse: 80 };
    for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) {
      deep = { wrap: deep };
    }

    expect(outJson(redactPhi(deep))).toContain(PHI_CENSOR);
  });
});

describe('конфиг редакции — контракт спецификации (§5/§7)', () => {
  it('PHI_REDACT_PATHS — ровно redact-пути из §5 + ключи БД (TASK-022 §14: pino.redact слой)', () => {
    expect([...PHI_REDACT_PATHS]).toEqual([
      'sys',
      'dia',
      'pulse',
      'note',
      'content',
      'question',
      'answer',
      '*.note',
      '*.content',
      'measurement',
      'measurements',
      // TASK-022 §14: ключ шифрования БД никогда не логируется — top-level и глубина 1.
      'keyHex',
      'key',
      '*.keyHex',
      '*.key',
    ]);
  });

  it('PHI_KEYS покрывает доменные PHI-поля §7 и ключи БД TASK-022 §14 (рекурсивный слой)', () => {
    for (const key of [
      'sys',
      'dia',
      'pulse',
      'note',
      'content',
      'question',
      'answer',
      'measurements',
      // TASK-022 §14: ключ шифрования БД — цензура на ЛЮБОЙ глубине.
      'keyHex',
      'key',
    ]) {
      expect(PHI_KEYS.has(key)).toBe(true);
    }
  });

  it('PHI_KEYS включает singular measurement из redact-путей §5', () => {
    expect(PHI_KEYS.has('measurement')).toBe(true);
  });
});
