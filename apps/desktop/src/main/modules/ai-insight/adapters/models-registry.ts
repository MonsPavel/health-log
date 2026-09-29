/**
 * TASK-079 §5/§9: ModelsRegistry — чтение/валидация статического манифеста
 * моделей (resources/models-manifest.json) — единственного источника «что
 * можно поставить» (§3). Каждый вызов listModels перечитывает и ревалидирует
 * ресурс zod-схемой contracts (MODELS_MANIFEST_SCHEMA): отказ любого вида
 * порчи (файл не читается, не-JSON, нарушение инвариантов §13, дубликаты id)
 * — контролируемый AppError APP/INTERNAL с cause (прецедент системных отказов
 * адаптеров — llm-process-client: spawn-файл недоступен → APP/INTERNAL) и
 * error-лог; стартер ИИ-модуля (081) глотает отказ — приложение живо (§5).
 *
 * ПУТЬ (§9): параметр manifestPath; по умолчанию — ресурс рядом с корнем
 * приложения: в packaged — внутри asar (app.asar/resources/…, чтение сквозь
 * asar штатно для fs), в dev — <app>/resources/…; одна и та же глубина
 * каталогов в исходной (src/main/modules/ai-insight/adapters) и собранной
 * (dist/main/modules/ai-insight/adapters) раскладке — прецедент дефолтного
 * пути от import.meta.url: entryPath клиента 076. Контейнер может передать
 * явный путь (app.getAppPath(), §9) — реестр electron не импортирует (§19:
 * тесты подменяют путь tmp-файлом).
 *
 * ЛОГГЕР (§18): структурный LlmClientLogger (боевой — createLogger('ai')),
 * по умолчанию молчун (прецедент клиента 076). В лог идут адрес ресурса и
 * техническая причина; zod-детали — в cause AppError (логи main, наружу не
 * сериализуются — TASK-006 §14).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MODELS_MANIFEST_SCHEMA, type ModelDescriptor } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type { LlmClientLogger } from './llm-process-client.js';

/** Манифест по умолчанию: <корень приложения>/resources/models-manifest.json (см. шапку). */
const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL('../../../../../resources/models-manifest.json', import.meta.url),
);

/** Опции реестра (§9: путь — параметр; тесты §19 подменяют tmp-файлом). */
export interface ModelsRegistryOptions {
  /** Путь ресурса манифеста; по умолчанию — resources/ в корне приложения. */
  readonly manifestPath?: string;
  /** Логгер отказов (§18); по умолчанию — молчун (прецедент клиента 076). */
  readonly logger?: LlmClientLogger;
}

/** Молчун-логгер (дефолт; боевой внедряет контейнер). */
const SILENT_LOGGER: LlmClientLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Реестр моделей (§5): валидация при загрузке — битый манифест → отказ списка
 * с логом (стартер ИИ-модуля 081 откажет старт ИИ, приложение работает).
 * Stateless: состояния нет, каждый вызов независим (правка списка = правка
 * файла/обновление приложения, §4).
 */
export class ModelsRegistry {
  private readonly manifestPath: string;
  private readonly logger: LlmClientLogger;

  constructor(options: ModelsRegistryOptions = {}) {
    this.manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  /**
   * Список поддерживаемых моделей (§5): чтение + JSON.parse + zod-валидация.
   * Любая порча ресурса — AppError APP/INTERNAL (reason 'models-manifest',
   * причина в cause) и error-лог с адресом ресурса.
   */
  listModels(): ModelDescriptor[] {
    try {
      const raw = readFileSync(this.manifestPath, 'utf8');
      return MODELS_MANIFEST_SCHEMA.parse(JSON.parse(raw) as unknown);
    } catch (cause) {
      this.logger.error('models: manifest rejected', {
        path: this.manifestPath,
        reason: 'models-manifest',
      });
      // Контракт ошибок TASK-006: наружу AppError, детали — в cause (логи main).
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- AppError по построению (прецедент llm-process-client/queue.stream)
      throw AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' }, cause);
    }
  }
}
