/**
 * TASK-081 §5/§9: AiModelsQueries — прикладные обёртки экрана «Модель» над
 * ModelStore (080), реестром манифеста (079) и prefs (047). Слой тонкий (§9):
 *  - list — одним вызовом всё для экрана (§7): витрины {descriptor, state,
 *    bytesLoaded?, errorKey?} + ОЗУ машины (os.totalmem — порт ramTotalGb) +
 *    язык интерфейса (порт uiLanguage — для предупреждения FR-5.9);
 *  - download/resume — делегирование store (флоу 080: guard'ы → сеть →
 *    верификация → rename; ход — событиями ai:progress);
 *  - pause/reset — операция store + статус после (мгновенно, §5 080);
 *  - select — id ОБЯЗАН быть в манифесте (мусор в prefs не проходит, §13), затем
 *    prefs.aiSettings заменяется ЦЕЛИКОМ с сохранением dismissed (семантика
 *    схемы 081; ensureModel зовётся ЛЕНИВО генерацией — 087, не здесь, §9).
 *
 * TEST-INSTALL (§22): порт testInstall (контейнер собирает его из env
 * HL_TEST_MODEL_FILE, гард не-packaged — паттерн HL_FAKE_LLM) подменяет download
 * установкой локального файла мимо сети — dev-модель с PLACEHOLDER-URL манифеста
 * (079) через сетевой store не проходит, а e2e §20-6 нужен. Боевой путь не тронут.
 *
 * ОШИБКИ (§13): все методы — Result (наружу из хендлера — AppError → ApiFailure,
 * каркас TASK-008); отказ реестра (битый манифест) — AppError APP/INTERNAL 079
 * пробрасывается в err без выброса. PHI нет — payload только сигналы (§14).
 */
import { AppError, err, ok, type Result } from '@hl/kernel';
import type {
  AiModelsListResponse,
  AiModelsSelectResponse,
  ModelDescriptor,
  ModelStatusInfo,
  ModelView,
  Prefs,
  PrefsPatch,
} from '@hl/contracts';

/** Порт prefs (047): структурно PreferencesService — чтение + patch (§9). */
export interface ModelsPrefsPort {
  getPrefs(): Promise<Prefs>;
  setPrefs(patch: PrefsPatch): Promise<Prefs>;
}

/** Каталог моделей (079): структурно ModelsRegistry — источник «что можно ставить». */
export interface ModelsCatalogPort {
  listModels(): ModelDescriptor[];
}

/** Порт ModelStore (080): структурно адаптер — управление загрузкой и статусы. */
export interface ModelStorePort {
  download(modelId: string): Promise<Result<ModelStatusInfo>>;
  resume(modelId: string): Promise<Result<ModelStatusInfo>>;
  pause(modelId: string): void;
  reset(modelId: string): void;
  status(modelId: string): ModelStatusInfo;
}

/**
 * TEST-ONLY установка мимо сети (§22): включаемость решает контейнер (гард env
 * не-packaged); install — копия локального файла в каталог моделей под именем
 * дескриптора, Result наружу (err — модели нет в манифесте / файл не читается).
 */
export interface TestModelInstallPort {
  isEnabled(): boolean;
  install(modelId: string): Promise<Result<ModelStatusInfo>>;
}

/** Зависимости use case (§5/§9): всё внедряет контейнер, тесты — подмены (§19). */
export interface AiModelsQueriesDeps {
  readonly store: ModelStorePort;
  readonly registry: ModelsCatalogPort;
  readonly prefs: ModelsPrefsPort;
  /** ОЗУ машины в ГБ (os.totalmem main, §5: поле list-ответа для предупреждения). */
  readonly ramTotalGb: () => number;
  /** Язык интерфейса приложения (MVP — 'ru'; FR-5.9 сравнение с языками модели). */
  readonly uiLanguage: () => string;
  /** TEST-ONLY установка мимо сети (§22); absence — боевой путь. */
  readonly testInstall?: TestModelInstallPort;
}

/** AiModelsQueries (§5): singleton контейнера, потребители — хендлеры ai/models/*. */
export class AiModelsQueries {
  private readonly store: ModelStorePort;
  private readonly registry: ModelsCatalogPort;
  private readonly prefs: ModelsPrefsPort;
  private readonly ramTotalGb: () => number;
  private readonly uiLanguage: () => string;
  private readonly testInstall: TestModelInstallPort | undefined;

  constructor(deps: AiModelsQueriesDeps) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.prefs = deps.prefs;
    this.ramTotalGb = deps.ramTotalGb;
    this.uiLanguage = deps.uiLanguage;
    this.testInstall = deps.testInstall;
  }

  /**
   * Список моделей для экрана (§7): дескрипторы манифеста + статус store на
   * каждый; ОЗУ машины и язык UI — из портов. Битый манифест → err (AppError
   * реестра 079; хендлер вернёт ApiFailure, экран покажет состояние ошибки).
   */
  async list(): Promise<Result<AiModelsListResponse>> {
    let descriptors: ModelDescriptor[];
    try {
      descriptors = this.registry.listModels();
    } catch (cause) {
      return err(
        cause instanceof AppError
          ? cause
          : AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' }, cause),
      );
    }
    const models: ModelView[] = descriptors.map((descriptor) => {
      const status = this.store.status(descriptor.id);
      const view: ModelView = { descriptor, state: status.state };
      if (status.bytesLoaded !== undefined) {
        view.bytesLoaded = status.bytesLoaded;
      }
      if (status.errorKey !== undefined) {
        view.errorKey = status.errorKey;
      }
      return view;
    });
    return ok({ models, ramTotalGb: this.ramTotalGb(), uiLanguage: this.uiLanguage() });
  }

  /**
   * Скачать модель (§5): test-install (§22) — установка мимо сети; иначе — флоу
   * store 080. Ответ канала — финал (installed/paused) или мгновенный отказ
   * guard'а (AI/DOWNLOAD_BUSY и др.); ход — событиями ai:progress (§11).
   */
  async download(modelId: string): Promise<Result<ModelStatusInfo>> {
    if (this.testInstall !== undefined && this.testInstall.isEnabled()) {
      return this.testInstall.install(modelId);
    }
    return this.store.download(modelId);
  }

  /** Продолжить загрузку (§5): делегирование store (Range-докачка 080). */
  async resume(modelId: string): Promise<Result<ModelStatusInfo>> {
    return this.store.resume(modelId);
  }

  /** Пауза (§5): abort попытки store + статус после (paused + bytesLoaded). */
  async pause(modelId: string): Promise<Result<ModelStatusInfo>> {
    this.store.pause(modelId);
    return ok(this.store.status(modelId));
  }

  /** Сброс терминальной ошибки (§7 080): error → not_installed, хвосты удалены. */
  async reset(modelId: string): Promise<Result<ModelStatusInfo>> {
    this.store.reset(modelId);
    return ok(this.store.status(modelId));
  }

  /**
   * Выбрать активную модель (§5/§9): id — только из манифеста; prefs.aiSettings
   * заменяется ЦЕЛИКОМ (dismissed сохраняется — решение «позже» не сбрасывается
   * выбором), ensureModel НЕ зовётся — лениво генерацией 087 (§9: быстрый UI).
   */
  async select(modelId: string): Promise<Result<AiModelsSelectResponse>> {
    let known: boolean;
    try {
      known = this.registry.listModels().some((model) => model.id === modelId);
    } catch (cause) {
      return err(
        cause instanceof AppError
          ? cause
          : AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' }, cause),
      );
    }
    if (!known) {
      return err(
        AppError.of('AI/MODEL_NOT_FOUND', 'errors.AI_MODEL_NOT_FOUND', { model: modelId }),
      );
    }
    const prefs = await this.prefs.getPrefs();
    await this.prefs.setPrefs({ aiSettings: { ...prefs.aiSettings, modelId } });
    return ok({ modelId });
  }
}
