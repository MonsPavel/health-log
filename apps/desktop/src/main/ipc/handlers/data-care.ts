/**
 * Хендлеры каналов Data Care (TASK-073 §5/§11) — слой тонкий, прецедент report.ts
 * (TASK-065) и report-pdf.ts (TASK-068): zod-валидацию запроса делает каркас
 * TASK-008 до вызова хендлера; здесь — вызов use case (070/071/072) и маппинг
 * Result → контракт:
 *  - `backup/create` {mode:'ask', passphrase} → {file: basename, sizeBytes, manifest}:
 *    ПОЛНЫЙ путь файла остаётся в main (§14: userData содержит имя Windows-пользователя);
 *    err (BACKUP/CANCELED при отказе диалога сохранения — ожидаемый исход §13 070,
 *    BACKUP/FAILED) → AppError бросается наружу: каркас вернёт ApiFailure(toDto);
 *  - `backup/restore` двухфазный: confirmed:false → план в форме контракта
 *    (ПОЛНЫЙ манифест наружу не идёт — §14: соль/запись kdf/хеш рендереру не нужны);
 *    confirmed:true → {restarting: true} (перезапуск запланирован use case'ом §9 071);
 *  - `data/wipe` двухфазный по phase: plan → {plan}, execute → {restarting: true}
 *    (§9 072).
 */
import { isErr, type AppError, type Result } from '@hl/kernel';

import type {
  BackupCreateRequest,
  BackupCreateResponse,
  BackupRestorePlan,
  BackupRestoreRequest,
  BackupRestoreResponse,
  DataDiscardDbRequest,
  DataDiscardDbResponse,
  DataWipeRequest,
  DataWipeResponse,
} from '@hl/contracts';

import type { CreateBackupResult } from '../../modules/data-care/application/create-backup.js';
import type {
  RestoreBackupResultValue,
  RestorePlan,
} from '../../modules/data-care/application/restore-backup.js';
import type { WipeAllDataResultValue } from '../../modules/data-care/application/wipe-all.js';

/**
 * Фабрика хендлера `backup/create`: use case инъекцируется контейнером (TASK-027).
 * Ответ — {file, sizeBytes, manifest} по схеме 070; путь среза — `value.path` не
 * копируется (§14).
 */
export function createBackupCreateHandler(useCase: {
  execute(command: BackupCreateRequest): Promise<Result<CreateBackupResult, AppError>>;
}): (payload: BackupCreateRequest) => Promise<BackupCreateResponse> {
  return async (payload) => {
    const resolved = await useCase.execute(payload);
    if (isErr(resolved)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (§9; каркас конвертирует в ApiFailure(toDto), прецедент report.ts)
      throw resolved.error;
    }
    const { file, sizeBytes, manifest } = resolved.value;
    return { file, sizeBytes, manifest };
  };
}

/**
 * Фабрика хендлера `backup/restore` (двухфазный, §11 071): фаза плана переводит
 * внутренний RestorePlan (с манифестом) в контрактную форму без манифеста (§14).
 */
export function createBackupRestoreHandler(useCase: {
  execute(command: BackupRestoreRequest): Promise<Result<RestoreBackupResultValue, AppError>>;
}): (payload: BackupRestoreRequest) => Promise<BackupRestoreResponse> {
  return async (payload) => {
    const resolved = await useCase.execute(payload);
    if (isErr(resolved)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (§9; каркас конвертирует в ApiFailure(toDto), прецедент report.ts)
      throw resolved.error;
    }
    const value = resolved.value;
    return 'plan' in value ? { plan: toPlanDto(value.plan) } : value;
  };
}

/** Фабрика хендлера `data/wipe` (двухфазный по phase, §11 072): план копируется в
 * мутабельную контрактную форму (readonly-массивы use case не проходят z.output). */
export function createDataWipeHandler(useCase: {
  execute(command: DataWipeRequest): Promise<Result<WipeAllDataResultValue, AppError>>;
}): (payload: DataWipeRequest) => Promise<DataWipeResponse> {
  return async (payload) => {
    const resolved = await useCase.execute(payload);
    if (isErr(resolved)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (§9; каркас конвертирует в ApiFailure(toDto), прецедент report.ts)
      throw resolved.error;
    }
    const value = resolved.value;
    return 'plan' in value
      ? {
          plan: {
            files: value.plan.files.map((file) => ({ path: file.path, category: file.category })),
            counts: value.plan.counts,
            rendererLocalStorage: value.plan.rendererLocalStorage,
          },
        }
      : value;
  };
}

/** Внутренний план восстановления → контракт (§14: манифест наружу не идёт). */
function toPlanDto(plan: RestorePlan): BackupRestorePlan {
  return {
    schemaVersion: plan.manifest.schemaVersion,
    schemaDelta: plan.schemaDelta,
    createdAtUtc: plan.manifest.createdAtUtc,
    counts: plan.manifest.counts,
    currentCounts: plan.currentCounts,
    warnings: [...plan.warnings],
  };
}

/**
 * Фабрика хендлера `data/discard-db` (TASK-101 §5/§9/§11): «начать заново» на
 * recovery-экране — {} → {restarting: true} (unlink db/-wal/-shm + отложенный
 * relaunch, §8). Канал регистрируется ТОЛЬКО в recovery-режиме (в здоровом —
 * «неизвестный канал» — инвентарь-тест контейнера); подтверждения — забота UI
 * (двойное подтверждение §13), use case подтверждений не имеет.
 */
export function createDataDiscardDbHandler(useCase: {
  execute(): Promise<Result<DataDiscardDbResponse, AppError>>;
}): (payload: DataDiscardDbRequest) => Promise<DataDiscardDbResponse> {
  return async () => {
    const resolved = await useCase.execute();
    if (isErr(resolved)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (§9; каркас конвертирует в ApiFailure(toDto), прецедент data/wipe)
      throw resolved.error;
    }
    return resolved.value;
  };
}
