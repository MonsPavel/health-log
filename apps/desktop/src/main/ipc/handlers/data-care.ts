/**
 * Хендлеры каналов Data Care `backup/create`, `backup/restore`, `data/wipe`
 * (TASK-073 §5/§11) — слой тонкий, прецедент report.ts: zod-валидацию запроса
 * делает каркас TASK-008 до вызова хендлера; здесь — вызов use case'ов 070/071/072
 * (уже подключены в контейнер: create — TASK-070, restore/wipe — эта задача) и
 * маппинг Result → контракт:
 *  - ok → ответ канала по схеме data-care;
 *  - err → AppError бросается наружу: каркас ловит его и возвращает
 *    ApiFailure(toDto) (register-channel §13 п. 3–4) — BACKUP/*, WIPE/*.
 *
 * БЕЗОПАСНОСТЬ (§14): ответ create — {file (basename), sizeBytes, manifest}, полный
 * путь копии (поле `path` CreateBackupResult, userData) наружу не идёт; план
 * restore — манифест схлопывается до полей контракта (соль/kdf/dbSha256 renderer'у
 * не нужны — минимум данных); команды пароль/file идут как есть (валидированы
 * схемой), пароль логируется только redact-страховкой TASK-010.
 */
import { isErr, type AppError, type Result } from '@hl/kernel';

import type {
  BackupCreateRequest,
  BackupCreateResponse,
  BackupRestoreRequest,
  BackupRestoreResponse,
  DataWipeRequest,
  DataWipeResponse,
} from '@hl/contracts';

import type { BackupCreateResult } from '../../modules/data-care/application/create-backup.js';
import type {
  RestoreBackupCommand,
  RestoreBackupResultValue,
} from '../../modules/data-care/application/restore-backup.js';
import type {
  WipeAllDataCommand,
  WipeAllDataResultValue,
} from '../../modules/data-care/application/wipe-all.js';

/** Структурный порт use case создания копии (070; стаб в тестах, §19). */
export interface BackupCreatePort {
  execute(command: BackupCreateRequest): Promise<Result<BackupCreateResult, AppError>>;
}

/** Структурный порт use case восстановления (071; стаб в тестах, §19). */
export interface RestoreBackupPort {
  execute(command: RestoreBackupCommand): Promise<Result<RestoreBackupResultValue, AppError>>;
}

/** Структурный порт use case полного удаления (072; стаб в тестах, §19). */
export interface WipeAllDataPort {
  execute(command: WipeAllDataCommand): Promise<Result<WipeAllDataResultValue, AppError>>;
}

/**
 * Фабрика хендлера `backup/create`: use case инъекцируется контейнером (TASK-027).
 * Команда проходит целиком (discriminated по mode — ask|auto, контракт 070); ответ
 * — {file, sizeBytes, manifest} по строгой схеме (§11).
 */
export function createBackupCreateHandler(
  useCase: BackupCreatePort,
): (payload: BackupCreateRequest) => Promise<BackupCreateResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    if (isErr(result)) {
      // Наружу только AppError ровно на границе каркаса (§13 п. 3; прецедент report.ts).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error;
    }
    // §14: field path (полный путь) наружу не идёт — только basename/размер/манифест.
    return { file: result.value.file, sizeBytes: result.value.sizeBytes, manifest: result.value.manifest };
  };
}

/**
 * Фабрика хендлера `backup/restore` (двухфазный, §7/§11): фаза 1 (confirmed: false)
 * → план без манифеста (schemaVersion/createdAtUtc/counts из манифеста — поля
 * контракта); фаза 2 (confirmed: true) → {restarting: true} (relaunch отложен в
 * контейнере — ответ уходит до выхода, §9).
 */
export function createRestoreBackupHandler(
  useCase: RestoreBackupPort,
): (payload: BackupRestoreRequest) => Promise<BackupRestoreResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    if (isErr(result)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error;
    }
    if ('restarting' in result.value) {
      return { restarting: true };
    }
    const plan = result.value.plan;
    return {
      plan: {
        schemaVersion: plan.manifest.schemaVersion,
        schemaDelta: plan.schemaDelta,
        createdAtUtc: plan.manifest.createdAtUtc,
        counts: plan.manifest.counts,
        currentCounts: plan.currentCounts,
        warnings: [...plan.warnings],
      },
    };
  };
}

/**
 * Фабрика хендлера `data/wipe` (двухфазный по phase, §5/§11): plan → {plan}
 * (basename+категория — план строит main из фактических каталогов, §14);
 * execute → {restarting: true} (отложенный relaunch, §9).
 */
export function createWipeAllDataHandler(
  useCase: WipeAllDataPort,
): (payload: DataWipeRequest) => Promise<DataWipeResponse> {
  return async (payload) => {
    const result = await useCase.execute(payload);
    if (isErr(result)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error;
    }
    if ('restarting' in result.value) {
      return { restarting: true };
    }
    // Копия в мутабельные массивы (readonly-домен наружу по контракту — z.array).
    return {
      plan: {
        files: result.value.plan.files.map((file) => ({ ...file })),
        counts: { ...result.value.plan.counts },
        rendererLocalStorage: result.value.plan.rendererLocalStorage,
      },
    };
  };
}
