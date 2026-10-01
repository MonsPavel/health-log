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

  // TASK-076 §9/§13/§14/§5: llm-worker (UtilityProcess) — вторая генерация при активной
  // (BUSY, §9), краш/зависание воркера во время генерации (§13), заглушка движка до
  // TASK-077 (§5 «engine: not-configured»), отсутствие файла модели (§14 — валидация
  // пути на main-стороне до передачи воркеру).
  it('коды AI/BUSY, AI/WORKER_CRASHED, AI/ENGINE_NOT_CONFIGURED и AI/MODEL_NOT_FOUND присутствуют (TASK-076)', () => {
    expect(ERROR_CODES).toContain('AI/BUSY');
    expect(ERROR_CODES).toContain('AI/WORKER_CRASHED');
    expect(ERROR_CODES).toContain('AI/ENGINE_NOT_CONFIGURED');
    expect(ERROR_CODES).toContain('AI/MODEL_NOT_FOUND');
  });

  // TASK-080 §5/§13: ModelStore — недостаток места (sizeBytes + 100 МБ запас,
  // до старта и перед финальным rename), расхождение sha256 после полной загрузки
  // (.part удаляется) и вторая загрузка при активной (одна, §9).
  it('коды AI/DISK_FULL, AI/HASH_MISMATCH и AI/DOWNLOAD_BUSY присутствуют (TASK-080)', () => {
    expect(ERROR_CODES).toContain('AI/DISK_FULL');
    expect(ERROR_CODES).toContain('AI/HASH_MISMATCH');
    expect(ERROR_CODES).toContain('AI/DOWNLOAD_BUSY');
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

  // TASK-070 §5/§13: коды Data Care — создание копии: сбой операции (VACUUM INTO,
  // шифрование, запись контейнера — например, исчерпание диска) и отмена
  // пользователем (отказ диалога сохранения — ожидаемый исход).
  it('коды BACKUP/FAILED и BACKUP/CANCELED присутствуют (TASK-070)', () => {
    expect(ERROR_CODES).toContain('BACKUP/FAILED');
    expect(ERROR_CODES).toContain('BACKUP/CANCELED');
  });

  // TASK-071 §5/§13: коды Data Care — восстановление: копия новее текущей схемы
  // (EC-25), неверный пароль копии и отказ целостности контейнера/sha256.
  it('коды BACKUP/DB_NEWER, BACKUP/WRONG_PASSPHRASE и BACKUP/INTEGRITY присутствуют (TASK-071)', () => {
    expect(ERROR_CODES).toContain('BACKUP/DB_NEWER');
    expect(ERROR_CODES).toContain('BACKUP/WRONG_PASSPHRASE');
    expect(ERROR_CODES).toContain('BACKUP/INTEGRITY');
  });

  // TASK-072 §5/§11: код Data Care — полное удаление данных: сбой (в т.ч. частичный
  // unlink — что осталось, в params/cause; отказ двухшаговости и расхождение плана).
  it('код WIPE/FAILED присутствует (TASK-072)', () => {
    expect(ERROR_CODES).toContain('WIPE/FAILED');
  });

  // TASK-063 §5/§9: use case ExportCsv (reporting) — неуспех сборки выгрузки.
  it('код EXPORT/FAILED присутствует (TASK-063)', () => {
    expect(ERROR_CODES).toContain('EXPORT/FAILED');
  });

  // TASK-068 §5/§7: use case BuildPdfReport (reporting) — пустой период не
  // формируется (count=0) и отказ рендера/сборки payload (cause в лог).
  it('коды REPORT/EMPTY_PERIOD и REPORT/RENDER_FAILED присутствуют (TASK-068)', () => {
    expect(ERROR_CODES).toContain('REPORT/EMPTY_PERIOD');
    expect(ERROR_CODES).toContain('REPORT/RENDER_FAILED');
  });

  // TASK-093 §13/§19: двойная обёртка ключа (Argon2id passphrase) — неверный пароль
  // детектируется по auth-tag GCM (БД не открывается); обращение к БД до unlock —
  // контейнер в состоянии locked (§9/§12; управление состоянием — TASK-094).
  it('коды VAULT/WRONG_PASSPHRASE и VAULT/LOCKED присутствуют (TASK-093)', () => {
    expect(ERROR_CODES).toContain('VAULT/WRONG_PASSPHRASE');
    expect(ERROR_CODES).toContain('VAULT/LOCKED');
  });

  // TASK-094 §4/§13: экспоненциальный rate-limit unlock — попытка в окне backoff
  // отклоняется ДО проверки пароля (перебор непрактичен, §3); backoffSec в params —
  // текст «Подождите N с» (§17).
  it('код VAULT/RATE_LIMITED присутствует (TASK-094)', () => {
    expect(ERROR_CODES).toContain('VAULT/RATE_LIMITED');
  });
});
