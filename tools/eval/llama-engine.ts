/**
 * TASK-091 §5: движок eval для боевого прогона на РЕАЛЬНОЙ модели — адаптер
 * application-порта LlmEngine (078) над управляемой обвязкой llm-worker (077):
 * createManagedLlamaEngine + createNodeLlamaBackend (нативный import node-llama-cpp
 * ЛЕНИВЫЙ — при первой загрузке модели, см. шапку llama-engine.ts; сам модуль
 * грузится без натива — smoke на fake натива не касается).
 *
 * ПОЧЕМУ НЕ ProcessLlmEngine (076): тот спавнит Electron UtilityProcess — в
 * eval-процессе (tsx, plain node) Electron-рантайма нет. Движок воркера — обычный
 * node-модуль: тот же код инференса (валидация GGUF, контекст 4096, temperature
 * 0.3, idle-unload), та же модель, но в процессе eval.
 *
 * ПОВТОРЯЕМОСТЬ (§7 077: «seed — повторяемость eval TASK-091»): адаптер фиксирует
 * seed EVAL_SEED для каждой генерации — use case'ы (087/089) параметры протоколу
 * не передают (порт их не знает), поэтому точка фиксации — здесь. Упрощения eval
 * (документированные): cancel()/abort не используются — кейс выполняется до
 * финала (зависание ловится таймаутом процесса); status().busy всегда false —
 * кейсы гоняются строго последовательно (§15: параллельности нет).
 *
 * §14: путь модели приходит из CLI (--model), валидируется load'ом движка
 * (GGUF-magic — AI/MODEL_INVALID до натива, §13 077); сети нет.
 */
import type { GenerationParams } from '@hl/contracts';

import { GENERATION_DEFAULTS, createManagedLlamaEngine } from '../../apps/desktop/src/main/llm-worker/engine.js';
import { createNodeLlamaBackend } from '../../apps/desktop/src/main/llm-worker/llama-engine.js';
import type {
  EngineStatus,
  LlmEngine,
  LlmEngineChunk,
  LlmEngineRequest,
} from '../../apps/desktop/src/main/modules/ai-insight/application/ports/llm-engine.js';

/** Фиксированный seed сэмплинга eval (повторяемость прогона, §7 077). */
export const EVAL_SEED = 20261001;

/** Счётчик requestId генераций eval (протоколу нужен уникальный id — отмена/лог). */
let generationCounter = 0;

/** LlmEngine eval-процесса: реальная модель по пути, в этом же процессе. */
export class EvalLlamaEngine implements LlmEngine {
  private readonly worker = createManagedLlamaEngine(createNodeLlamaBackend());

  private loadedModelId: string | undefined;

  /** Загрузка модели по пути (идемпотентность — managed engine, §5 077). */
  ensureModel(modelId: string): Promise<void> {
    return this.worker.load(modelId).then(() => {
      this.loadedModelId = modelId;
    });
  }

  /**
   * Генерация (ленивый AsyncIterable — контракт порта §13 078): колбэк emit
   * managed-движка буферизуется, после финала дельты отдаются стримом; seed —
   * фиксированный (см. шапку), maxTokens — дефолт конфига движка.
   */
  async *complete(request: LlmEngineRequest): AsyncIterable<LlmEngineChunk> {
    const deltas: string[] = [];
    const requestId = `eval-${(generationCounter += 1)}`;
    const params: GenerationParams = { ...request.params, seed: EVAL_SEED };
    const finish = await this.worker.complete(
      {
        requestId,
        messages: request.messages,
        params,
        maxTokens: GENERATION_DEFAULTS.maxTokens,
      },
      (delta) => {
        deltas.push(delta);
      },
    );
    for (const delta of deltas) {
      yield { delta };
    }
    yield { done: finish };
  }

  /** Eval не отменяет генерации (см. шапку) — no-op (идемпотентность порта). */
  cancel(): void {
    this.worker.cancel(`eval-${generationCounter}`);
  }

  /** Статус (§7): loaded — модель загружена; busy не наблюдается (последовательно). */
  status(): EngineStatus {
    return {
      loaded: this.loadedModelId !== undefined,
      ...(this.loadedModelId === undefined ? {} : { modelId: this.loadedModelId }),
      busy: false,
    };
  }
}
