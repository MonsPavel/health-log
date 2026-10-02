/**
 * Хендлеры каналов сампроверки и «О приложении» `app/selfcheck|meta|integrity-full`
 * (TASK-100 §11) — слой тонкий, прецедент privacy.ts: zod-валидацию запроса делает
 * каркас TASK-008 до вызова хендлера. Ошибки каналов — валидационные и STORAGE/*
 * сервисов (наверх без конвертации); данные без путей/PHI (§14).
 */
import type {
  AppIntegrityFullRequest,
  AppIntegrityFullResponse,
  AppMetaRequest,
  AppMetaResponse,
  AppSelfcheckRequest,
  AppSelfcheckResponse,
  RecoveryContext,
} from '@hl/contracts';

import type { SelfCheckService } from '../../app/selfcheck.js';

/**
 * Фабрика хендлера `app/selfcheck` (§11): снимок старта из памяти сервиса;
 * null — самчек ещё не выполнялся (locked-старт до unlock).
 */
export function createAppSelfcheckHandler(
  selfcheck: SelfCheckService,
): (payload: AppSelfcheckRequest) => Promise<AppSelfcheckResponse> {
  return () => Promise.resolve(selfcheck.report ?? null);
}

/** Порты meta (§5/§11): версии собираются из фактов контейнера. */
export interface AppMetaPorts {
  /** Версия приложения (bootstrap передаёт app.getVersion(), §5). */
  readonly appVersion: string;
  /** Сервис сампроверки: schemaVersion — из снимка старта (статичен за сессию). */
  readonly selfcheck: SelfCheckService;
  /** Активная шкала (code+version) — ScaleService (кэш в памяти, §15 051). */
  readonly scales?: () => Promise<{ code: string; version: string }>;
  /** Активная модель (id+версия) — мета prefs+реестра 079 ('' — не выбрана). */
  readonly model?: () => Promise<{ modelId: string; modelVersion: string }>;
  /**
   * TASK-101 §10: контекст recovery-режима — ЛЕНИВОЕ чтение состояния контейнера
   * (в passphrase-режиме recovery вводится после unlock — позже сборки; гейт App
   * перечитывает meta). undefined/отсутствие — обычный старт.
   */
  readonly recovery?: () => RecoveryContext | undefined;
}

/**
 * Фабрика хендлера `app/meta` (§5/§11): строки версий «О приложении».
 * model входит в ответ ТОЛЬКО при непустых id И версии («модель id+version если
 * есть» — §5): выбранная модель без найденного дескриптора честно опускается.
 *
 * TASK-101 §9/§10: в recovery-режиме — форма {appVersion, schemaVersion, recovery}
 * БЕЗ чтений БД (шкала/модель недоступны — соединение закрыто; опускание полей —
 * контракт схемы, §7). Чтение порта recovery — ленивое (см. AppMetaPorts).
 */
export function createAppMetaHandler(
  ports: AppMetaPorts,
): (payload: AppMetaRequest) => Promise<AppMetaResponse> {
  return async () => {
    const recovery = ports.recovery?.();
    if (recovery !== undefined) {
      return {
        appVersion: ports.appVersion,
        schemaVersion: ports.selfcheck.report?.schemaVersion ?? 0,
        recovery,
      };
    }
    const scale = await ports.scales?.();
    const { modelId, modelVersion } = (await ports.model?.()) ?? { modelId: '', modelVersion: '' };
    return {
      appVersion: ports.appVersion,
      schemaVersion: ports.selfcheck.report?.schemaVersion ?? 0,
      ...(scale === undefined ? {} : { scale: { code: scale.code, version: scale.version } }),
      ...(modelId !== '' && modelVersion !== ''
        ? { model: { id: modelId, version: modelVersion } }
        : {}),
    };
  };
}

/**
 * Фабрика хендлера `app/integrity-full` (§4/§11): полная проверка БД по кнопке —
 * PRAGMA integrity_check на открытом соединении (долгий, <10 с — progress не нужен).
 * Синхронный хендлер (better-sqlite3 синхронный — прецедент арх. 03 §6).
 */
export function createAppIntegrityFullHandler(
  selfcheck: SelfCheckService,
): (payload: AppIntegrityFullRequest) => AppIntegrityFullResponse {
  return () => selfcheck.runFullIntegrity();
}
