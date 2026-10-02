/**
 * Каркас обработки IPC (TASK-008 §5/§13): единственная точка диспетчеризации main.
 * Порядок обработки вызова — §13:
 *  (1) канал существует? — иначе лог + APP/INTERNAL наружу;
 *  (2) payload валиден по zod-схеме? — иначе VALIDATION/FAILED (handler не вызывается);
 *  (2.5) TASK-094: secure-канал при locked? — VAULT/LOCKED ДО handler (гвардия
 *        requireUnlocked, ЕДИНАЯ обёртка §7/§11/§14: обход = ревью-блокер);
 *  (3) handler → конверт {ok:true,data} / AppError → {ok:false,error:toDto};
 *  (4) неизвестное исключение → лог с cause (только main-лог, §18), наружу APP/INTERNAL.
 *
 * TASK-094 §9 (idle-трекер): любой валидный транспортный запрос hl.* обновляет
 * lastActivity (onActivity — один патч каркаса; VaultService продлевает окно автоблока).
 *
 * TASK-101 §5/§9/§11/§14 (recovery-гвардия): расширение LOCKED-семантики — в
 * recovery-режиме (БД не открыта) secure-каналы вне разрешённого набора
 * (`recoveryAllowed`) отклоняются конвертом STORAGE/RECOVERY_MODE ДО валидации
 * payload (поверхность максимальна узкая — для заблокированного канала не работает
 * даже zod; инвентарь-тест контейнера фиксирует список разрешённых). Не-secure
 * каналы каркаса (app/*, file/open-dialog, vault/status|unlock|lock) не гвардятся.
 *
 * Транспорт: один канал `hl:invoke` (contracts.HL_INVOKE_CHANNEL), в который preload
 * кладёт {channel, payload} — у Electron нет hook на invoke незарегистрированного
 * канала, поэтому проверку «канал существует?» выполняет каркас (§11/§20). Прямые
 * ipcMain.handle вне каркаса запрещены конвенцией (§9).
 */
import { ipcMain } from 'electron';

import {
  apiFailure,
  apiSuccess,
  APP_INTERNAL_ERROR,
  RECOVERY_MODE_ERROR,
  VAULT_LOCKED_ERROR,
  VALIDATION_FAILED_ERROR,
  HL_INVOKE_CHANNEL,
  HL_INVOKE_REQUEST_SCHEMA,
  toDto,
  type ApiEnvelope,
  type ChannelName,
  type ChannelSchemas,
} from '@hl/contracts';
import { AppError } from '@hl/kernel';

/** Лог каркаса; реальный main-логгер (редакция PHI, арх. 09 §7) подключится своей задачей. */
export interface IpcLogger {
  warn(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
}

/** Консольный логгер; категория `ipc` — префикс каждой записи (§18). */
export function createConsoleIpcLogger(): IpcLogger {
  return {
    warn: (message, meta) => console.warn('[ipc]', message, meta),
    error: (message, meta) => console.error('[ipc]', message, meta),
  };
}

/** Обработчик канала: валидированный payload → ответ (синхронно или Promise, §9). */
export type ChannelHandler<TRequest, TResponse> = (
  payload: TRequest,
) => TResponse | Promise<TResponse>;

/** Реестр каналов: регистрация (единственный способ, §9) и диспетчеризация вызовов. */
export interface ChannelRegistry {
  register<TRequest, TResponse>(
    name: ChannelName,
    schemas: ChannelSchemas<TRequest, TResponse>,
    handler: ChannelHandler<TRequest, TResponse>,
  ): void;
  /** Обработка транспортного запроса рендерера; всегда конверт, исключения не проходят. */
  dispatch(request: unknown): Promise<ApiEnvelope<unknown>>;
}

/** Лимит payload — 5 МБ (§5/§11). Сериализованная длина — приближение: pre-check
 *  structuredClone-размера недоступен; в dev — предупреждение, не отказ (§11). */
const MAX_PAYLOAD_JSON_LENGTH = 5 * 1024 * 1024;

/** Длина JSON-сериализации значения; undefined — если значение не сериализуется. */
function serializedLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : json.length;
  } catch {
    return undefined;
  }
}

interface RegisteredChannel {
  readonly schemas: ChannelSchemas<unknown, unknown>;
  readonly handler: ChannelHandler<unknown, unknown>;
  /** TASK-094 §11: secure-канал — гвардится requireUnlocked при locked (VAULT/LOCKED). */
  readonly secure: boolean;
}

/** Опции фабрики реестра (для тестов); isDev по умолчанию — индикатор dev-скрипта. */
export interface ChannelRegistryOptions {
  /** §13 create-window: индикатор dev-режима — наличие ELECTRON_RENDERER_URL. */
  readonly isDev?: boolean;
  /**
   * TASK-094 §7/§11: состояние сессии для гвардии requireUnlocked (false — сессия
   * заблокирована). undefined — гвардия не активна (обратная совместимость).
   * Боевой — VaultService.isUnlocked (контейнер).
   */
  readonly isUnlocked?: () => boolean;
  /** TASK-094 §9: idle-трекер — вызывается на КАЖДЫЙ валидный транспортный запрос. */
  readonly onActivity?: () => void;
  /**
   * TASK-101 §5/§9: признак recovery-режима (БД не открыта — контейнер); undefined /
   * false — гвардия не активна (обычный старт). Боевой — состояние recovery
   * контейнера (замыкание buildContainer).
   */
  readonly isRecovery?: () => boolean;
  /**
   * TASK-101 §9: secure-каналы, разрешённые в recovery-режиме (backup/restore —
   * recovery-execute; data/discard-db — «начать заново»). Остальные secure —
   * STORAGE/RECOVERY_MODE (инвентарь-тест контейнера TASK-101 §19).
   */
  readonly recoveryAllowed?: readonly string[];
}

/** Фабрика реестра: чистая (без Electron) — интеграционные тесты гоняют её напрямую (§19). */
export function createChannelRegistry(
  logger: IpcLogger = createConsoleIpcLogger(),
  options: ChannelRegistryOptions = {},
): ChannelRegistry {
  const isDev = options.isDev ?? process.env['ELECTRON_RENDERER_URL'] !== undefined;
  const channels = new Map<ChannelName, RegisteredChannel>();

  return {
    register(name, schemas, handler) {
      if (channels.has(name)) {
        throw new Error(`IPC-канал уже зарегистрирован: ${name}`);
      }
      channels.set(name, {
        schemas,
        handler: handler as ChannelHandler<unknown, unknown>,
        // TASK-094 §11: secure-флаг из реестра контрактов — БД-канал (инвентарь AC5).
        secure: schemas.secure === true,
      });
    },

    async dispatch(request) {
      // (0) транспортная форма запроса {channel, payload} — недоверенный рендерер (§14).
      const transport = HL_INVOKE_REQUEST_SCHEMA.safeParse(request);
      if (!transport.success) {
        logger.error('битый запрос к транспортному каналу', { error: transport.error.message });
        return apiFailure(APP_INTERNAL_ERROR);
      }

      // TASK-094 §9: любое обращение рендерера — пользовательское действие
      // (окно автоблока продлевается до разбора канала).
      options.onActivity?.();

      // (1) канал существует?
      const channel = transport.data.channel as ChannelName;
      const entry = channels.get(channel);
      if (entry === undefined) {
        logger.error('неизвестный IPC-канал', { channel: transport.data.channel });
        return apiFailure(APP_INTERNAL_ERROR);
      }

      // (1.5) TASK-101 §5/§9/§11/§14: recovery-гвардия — ДО валидации payload
      // (поверхность максимальна узкая): secure-канал вне разрешённого набора в
      // recovery-режиме отклоняется конвертом STORAGE/RECOVERY_MODE (зеркало
      // requireUnlocked п. 2.5, ЕДИНАЯ обёртка каркаса).
      if (
        entry.secure &&
        options.isRecovery?.() === true &&
        options.recoveryAllowed?.includes(channel) !== true
      ) {
        return apiFailure(RECOVERY_MODE_ERROR);
      }

      // (2) payload валиден? — иначе VALIDATION/FAILED, handler не вызывается (§13, §20).
      const parsed = entry.schemas.request.safeParse(transport.data.payload);
      if (!parsed.success) {
        return apiFailure(VALIDATION_FAILED_ERROR);
      }

      // (2.5) TASK-094 §7/§11/§14: гвардия requireUnlocked — ЕДИНАЯ точка: secure-канал
      // при locked отклоняется ДО handler (side-эффектов и чтений закрытой БД нет).
      if (entry.secure && options.isUnlocked !== undefined && !options.isUnlocked()) {
        return apiFailure(VAULT_LOCKED_ERROR);
      }

      // §11: лимит payload 5 МБ — dev-предупреждение по валидированному payload.
      if (isDev) {
        const length = serializedLength(parsed.data);
        if (length !== undefined && length > MAX_PAYLOAD_JSON_LENGTH) {
          logger.warn('payload IPC-канала превышает 5 МБ — нужна пагинация на уровне канала', {
            channel: transport.data.channel,
            length,
          });
        }
      }

      // (3) handler → конверт; (4) AppError → DTO, неизвестное → лог с cause + APP/INTERNAL.
      try {
        const data = await entry.handler(parsed.data);
        return apiSuccess(data);
      } catch (error) {
        if (error instanceof AppError) {
          return apiFailure(toDto(error));
        }
        logger.error(`необработанная ошибка IPC-хендлера канала ${transport.data.channel}`, {
          channel: transport.data.channel,
          cause: error,
        });
        return apiFailure(APP_INTERNAL_ERROR);
      }
    },
  };
}

/** Реестр приложения; каналы регистрируются bootstrap-ом через registerChannel (§5). */
const appRegistry = createChannelRegistry();

/** registerChannel — единственный способ регистрации канала приложения (§5/§9). */
export function registerChannel<TRequest, TResponse>(
  name: ChannelName,
  schemas: ChannelSchemas<TRequest, TResponse>,
  handler: ChannelHandler<TRequest, TResponse>,
): void {
  appRegistry.register(name, schemas, handler);
}

/**
 * Установка транспортного моста в ipcMain (вызывается один раз из bootstrap);
 * registry — точка подстановки для тестов (§19: mock ipcMain/event).
 */
export function installChannelBridge(registry: ChannelRegistry = appRegistry): void {
  ipcMain.handle(HL_INVOKE_CHANNEL, (_event, request: unknown) => registry.dispatch(request));
}
