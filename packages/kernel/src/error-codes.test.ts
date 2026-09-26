// TASK-006 §19: реестр ErrorCode — уникальность кодов и начальный состав §5.
import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from './error-codes.js';

describe('ErrorCode: реестр кодов (§5)', () => {
  it('начальный состав присутствует: APP/INTERNAL, APP/NOT_IMPLEMENTED, VALIDATION/FAILED', () => {
    expect(ERROR_CODES).toContain('APP/INTERNAL');
    expect(ERROR_CODES).toContain('APP/NOT_IMPLEMENTED');
    expect(ERROR_CODES).toContain('VALIDATION/FAILED');
  });

  it('коды уникальны (§19)', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('формат кода — ВЕРХНИЙ_РЕГИСТР/ПОДКОД', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z]+(?:_[A-Z]+)*\/[A-Z]+(?:_[A-Z]+)*$/);
    }
  });

  // TASK-016 §5: коды домена Measurement для VO давления/пульса.
  it('коды MEASUREMENT/INVALID_RANGE и MEASUREMENT/SYS_LE_DIA присутствуют (TASK-016)', () => {
    expect(ERROR_CODES).toContain('MEASUREMENT/INVALID_RANGE');
    expect(ERROR_CODES).toContain('MEASUREMENT/SYS_LE_DIA');
  });

  // TASK-017 §5: коды агрегата BpMeasurement — «время не в будущем» и «заметка длинная».
  it('коды MEASUREMENT/FUTURE_TIME и MEASUREMENT/NOTE_TOO_LONG присутствуют (TASK-017)', () => {
    expect(ERROR_CODES).toContain('MEASUREMENT/FUTURE_TIME');
    expect(ERROR_CODES).toContain('MEASUREMENT/NOTE_TOO_LONG');
  });

  // TASK-022 §7/§13: коды SQLCipher-стека — открытие зашифрованной БД.
  it('коды STORAGE/BAD_KEY, STORAGE/LOCKED и STORAGE/CORRUPT присутствуют (TASK-022)', () => {
    expect(ERROR_CODES).toContain('STORAGE/BAD_KEY');
    expect(ERROR_CODES).toContain('STORAGE/LOCKED');
    expect(ERROR_CODES).toContain('STORAGE/CORRUPT');
  });

  // TASK-023 §5/§13: коды KeyVault — хранилище ключа БД на safeStorage.
  it('коды VAULT/KEY_MISSING, VAULT/KEY_CORRUPT и VAULT/UNAVAILABLE присутствуют (TASK-023)', () => {
    expect(ERROR_CODES).toContain('VAULT/KEY_MISSING');
    expect(ERROR_CODES).toContain('VAULT/KEY_CORRUPT');
    expect(ERROR_CODES).toContain('VAULT/UNAVAILABLE');
  });

  // TASK-024 §5/§20: коды migration runner — сбой миграции (rollback, с номером
  // версии) и «БД новее приложения» (EC-25: обновите приложение).
  it('коды STORAGE/MIGRATION_FAILED и STORAGE/DB_NEWER_THAN_APP присутствуют (TASK-024)', () => {
    expect(ERROR_CODES).toContain('STORAGE/MIGRATION_FAILED');
    expect(ERROR_CODES).toContain('STORAGE/DB_NEWER_THAN_APP');
  });
});
