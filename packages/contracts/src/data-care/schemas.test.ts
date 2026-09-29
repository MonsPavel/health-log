/**
 * TASK-070 §19/071 §19: контракт-тесты Data Care — формы каналов `backup/create` и
 * `backup/restore` и манифеста копии (валидатор восстановления TASK-071).
 *
 * Матрица:
 *  - манифест: полная форма §2 разбирается; каждое поле §2 обязательно (strict —
 *    лишние/недостающие поля отвергаются); dbSha256 — строго lowercase-hex 64;
 *  - kdf — discriminated union: `db-key` (авто-копия hook'а, §5/§9) и `argon2id`
 *    с параметрами/солью (§8); посторонний id отвергается;
 *  - запрос create: `ask` требует непустой пароль (§8; политика ≥8 — предупреждение UI
 *    073, не блокировка, §13 — пароль из 1 символа формой допускается);
 *    `auto` — без пароля, опциональное имя файла в безопасном наборе символов
 *    (IPC-гигиена §14: `../`, абсолютные пути, чужие расширения отвергаются);
 *  - ответ create: basename + размер + манифест; полный путь не предусмотрен (§14);
 *  - restore (071 §11): двухфазный запрос discriminated union по confirmed
 *    (false → план, true → execute); план — schemaDelta/warnings/counts (§5/§7);
 *    ответ — union {plan} | {restarting: true}.
 */
import { describe, expect, it } from 'vitest';

import {
  BACKUP_CREATE_REQUEST_SCHEMA,
  BACKUP_CREATE_RESPONSE_SCHEMA,
  BACKUP_MANIFEST_SCHEMA,
  BACKUP_RESTORE_PLAN_SCHEMA,
  BACKUP_RESTORE_REQUEST_SCHEMA,
  BACKUP_RESTORE_RESPONSE_SCHEMA,
} from './schemas.js';

/** Валидный манифест-пример (§2): все поля, kdf=argon2id. */
const validManifest = {
  formatVersion: 1,
  schemaVersion: 4,
  appVersion: '0.0.0',
  createdAtUtc: 1_758_816_000_000,
  counts: { measurements: 3 },
  dbSha256: 'a'.repeat(64),
  kdf: {
    id: 'argon2id',
    saltB64: 'CsoEmS0RK+rHTStZ2Zc+Gg==',
    iterations: 3,
    memoryKib: 65536,
    parallelism: 4,
  },
};

describe('BACKUP_MANIFEST_SCHEMA (TASK-070 §7: валидатор восстановления 071)', () => {
  it('полная форма §2 разбирается', () => {
    expect(BACKUP_MANIFEST_SCHEMA.parse(validManifest)).toEqual(validManifest);
  });

  it('все поля §2 обязательны, лишние отвергаются (strict)', () => {
    for (const key of Object.keys(validManifest)) {
      const without = { ...validManifest } as Record<string, unknown>;
      delete without[key];
      expect(BACKUP_MANIFEST_SCHEMA.safeParse(without).success).toBe(false);
    }
    expect(BACKUP_MANIFEST_SCHEMA.safeParse({ ...validManifest, extra: 1 }).success).toBe(false);
  });

  it('dbSha256 — строго 64 hex-символа', () => {
    expect(
      BACKUP_MANIFEST_SCHEMA.safeParse({ ...validManifest, dbSha256: 'zz'.repeat(32) }).success,
    ).toBe(false);
    expect(
      BACKUP_MANIFEST_SCHEMA.safeParse({ ...validManifest, dbSha256: 'a'.repeat(63) }).success,
    ).toBe(false);
  });

  it('kdf: db-key (авто-копия без диалога, §5/§9) и argon2id (§8) разбираются', () => {
    expect(BACKUP_MANIFEST_SCHEMA.parse({ ...validManifest, kdf: { id: 'db-key' } })).toMatchObject(
      { kdf: { id: 'db-key' } },
    );
    expect(
      BACKUP_MANIFEST_SCHEMA.safeParse({
        ...validManifest,
        kdf: { id: 'scrypt', saltB64: 'x' },
      }).success,
    ).toBe(false);
  });

  it('kdf argon2id: параметры — целые в допустимых пределах', () => {
    expect(
      BACKUP_MANIFEST_SCHEMA.safeParse({
        ...validManifest,
        kdf: { ...validManifest.kdf, iterations: 0 },
      }).success,
    ).toBe(false);
    expect(
      BACKUP_MANIFEST_SCHEMA.safeParse({
        ...validManifest,
        kdf: { ...validManifest.kdf, memoryKib: 7.5 },
      }).success,
    ).toBe(false);
  });
});

describe('BACKUP_CREATE_REQUEST_SCHEMA (TASK-070 §6: {mode: ask|auto})', () => {
  it('ask: непустой пароль обязателен (§8)', () => {
    expect(
      BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'ask', passphrase: 'пароль' }).success,
    ).toBe(true);
    expect(BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'ask', passphrase: '' }).success).toBe(
      false,
    );
    expect(BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'ask' }).success).toBe(false);
  });

  it('§13: пароль короче 8 символов формой НЕ блокируется (предупреждение — UI 073)', () => {
    expect(BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'ask', passphrase: 'x' }).success).toBe(
      true,
    );
  });

  it('auto: пароля нет; targetName — безопасное имя *.hlbackup (IPC-гигиена §14)', () => {
    expect(BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'auto' }).success).toBe(true);
    expect(
      BACKUP_CREATE_REQUEST_SCHEMA.safeParse({
        mode: 'auto',
        targetName: 'pre-migration-v2.hlbackup',
      }).success,
    ).toBe(true);
    expect(
      BACKUP_CREATE_REQUEST_SCHEMA.safeParse({
        mode: 'auto',
        targetName: '../evil.hlbackup',
      }).success,
    ).toBe(false);
    expect(
      BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'auto', targetName: 'x.txt' }).success,
    ).toBe(false);
  });

  it('режим строго один из ask|auto; лишние поля отвергаются (strict)', () => {
    expect(BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'restore' }).success).toBe(false);
    expect(BACKUP_CREATE_REQUEST_SCHEMA.safeParse({ mode: 'auto', passphrase: 'x' }).success).toBe(
      false,
    );
  });
});

describe('BACKUP_CREATE_RESPONSE_SCHEMA (TASK-070 §18: basename, не полный путь)', () => {
  it('basename + sizeBytes + манифест разбираются', () => {
    const response = {
      file: 'health-log-backup-20260929T120000.hlbackup',
      sizeBytes: 40_960,
      manifest: validManifest,
    };
    expect(BACKUP_CREATE_RESPONSE_SCHEMA.parse(response)).toEqual(response);
  });

  it('нулевой размер и отсутствующий манифест отвергаются', () => {
    expect(
      BACKUP_CREATE_RESPONSE_SCHEMA.safeParse({
        file: 'x.hlbackup',
        sizeBytes: 0,
        manifest: validManifest,
      }).success,
    ).toBe(false);
    expect(
      BACKUP_CREATE_RESPONSE_SCHEMA.safeParse({ file: 'x.hlbackup', sizeBytes: 10 }).success,
    ).toBe(false);
  });
});

/** Валидный план восстановления (071 §5/§7: дельта, счётчики, предупреждения). */
const validPlan = {
  schemaVersion: 4,
  schemaDelta: 'equal',
  createdAtUtc: 1_758_816_000_000,
  counts: { measurements: 120 },
  currentCounts: { measurements: 350 },
  warnings: ['replaces-current'],
};

describe('BACKUP_RESTORE_PLAN_SCHEMA (TASK-071 §5/§7)', () => {
  it('полная форма плана разбирается', () => {
    expect(BACKUP_RESTORE_PLAN_SCHEMA.parse(validPlan)).toEqual(validPlan);
  });

  it('schemaDelta — только equal|older|newer; поля обязательны (strict)', () => {
    expect(
      BACKUP_RESTORE_PLAN_SCHEMA.safeParse({ ...validPlan, schemaDelta: 'merge' }).success,
    ).toBe(false);
    const without = { ...validPlan } as Record<string, unknown>;
    delete without['currentCounts'];
    expect(BACKUP_RESTORE_PLAN_SCHEMA.safeParse(without).success).toBe(false);
    expect(BACKUP_RESTORE_PLAN_SCHEMA.safeParse({ ...validPlan, extra: 1 }).success).toBe(false);
  });

  it('warnings — enum replaces-current|older-than-current (§7: обе допустимы)', () => {
    expect(
      BACKUP_RESTORE_PLAN_SCHEMA.parse({
        ...validPlan,
        schemaDelta: 'older',
        warnings: ['replaces-current', 'older-than-current'],
      }).warnings,
    ).toEqual(['replaces-current', 'older-than-current']);
    expect(
      BACKUP_RESTORE_PLAN_SCHEMA.safeParse({ ...validPlan, warnings: ['surprise'] }).success,
    ).toBe(false);
  });
});

describe('BACKUP_RESTORE_REQUEST_SCHEMA (TASK-071 §11: две фазы по confirmed)', () => {
  it('фаза 1 {file, passphrase, confirmed: false} разбирается', () => {
    expect(
      BACKUP_RESTORE_REQUEST_SCHEMA.safeParse({
        confirmed: false,
        file: 'C:\\backup\\health-log-backup.hlbackup',
        passphrase: 'пароль-копии',
      }).success,
    ).toBe(true);
  });

  it('фаза 2 {…, confirmed: true} разбирается; без пароля/файла — отказ', () => {
    expect(
      BACKUP_RESTORE_REQUEST_SCHEMA.safeParse({
        confirmed: true,
        file: 'x.hlbackup',
        passphrase: 'пароль-копии',
      }).success,
    ).toBe(true);
    expect(
      BACKUP_RESTORE_REQUEST_SCHEMA.safeParse({ confirmed: true, file: 'x.hlbackup' }).success,
    ).toBe(false);
    expect(
      BACKUP_RESTORE_REQUEST_SCHEMA.safeParse({
        confirmed: false,
        file: 'x.hlbackup',
        passphrase: '',
      }).success,
    ).toBe(false);
  });

  it('confirmed отсутствует или лишние поля — отказ (strict)', () => {
    expect(BACKUP_RESTORE_REQUEST_SCHEMA.safeParse({ file: 'x', passphrase: 'p' }).success).toBe(
      false,
    );
    expect(
      BACKUP_RESTORE_REQUEST_SCHEMA.safeParse({
        confirmed: false,
        file: 'x',
        passphrase: 'p',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('BACKUP_RESTORE_RESPONSE_SCHEMA (TASK-071 §11: plan | restarting)', () => {
  it('фаза 1: {plan} разбирается', () => {
    expect(BACKUP_RESTORE_RESPONSE_SCHEMA.parse({ plan: validPlan })).toEqual({ plan: validPlan });
  });

  it('фаза 2: {restarting: true} разбирается; restart false / пустой объект — отказ', () => {
    expect(BACKUP_RESTORE_RESPONSE_SCHEMA.safeParse({ restarting: true }).success).toBe(true);
    expect(BACKUP_RESTORE_RESPONSE_SCHEMA.safeParse({ restarting: false }).success).toBe(false);
    expect(BACKUP_RESTORE_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });
});
