/**
 * Хендлер канала `ai/context/preview` (TASK-083 §5/§11/§18): слой тонкий,
 * прецедент stats.ts — zod-валидацию запроса делает каркас TASK-008 до вызова
 * хендлера, здесь — резолв modelId из prefs (§11: modelId в запрос не входит),
 * вызов AiContextBuilder.build и замер длительности (§18):
 * `ai/context/preview period=… notes=bool sections=N durationMs=…`. ТЕКСТ
 * КОНТЕКСТА В ЛОГ НЕ ПИШЕТСЯ — PHI (заметки пользователя, §14); sections/count —
 * агрегаты. Отказов домена нет (§9): STORAGE/* пробрасывается портами выше —
 * каркас вернёт ApiFailure; пустой период — валидный контекст (§11).
 */
import { performance } from 'node:perf_hooks';

import type { AiContextPreviewRequest, AiContextPreviewResponse } from '@hl/contracts';

import type { AiContextBuilder } from '../../modules/ai-insight/application/ai-context-builder.js';

/** Минимальная поверхность логгера хендлера (§18; HlLogger ей удовлетворяет). */
export interface AiContextHandlerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Источник активной модели (§11): prefs.aiSettings.modelId; '' — модель не выбрана. */
export type AiContextModelIdProvider = () => Promise<string>;

/** Метка периода для лога (§18): пресет как есть, custom — без границ (шум). */
function periodLabel(period: AiContextPreviewRequest['period']): string {
  return typeof period === 'string' ? period : 'custom';
}

/**
 * Фабрика хендлера `ai/context/preview`: сборщик и источник modelId инъекцируются
 * контейнером (TASK-027). Ответ — {text, sections, hash} по строгой схеме
 * TASK-083 (§11); sections — копия (readonly сборщика → проводной массив).
 */
export function createAiContextPreviewHandler(
  builder: AiContextBuilder,
  modelId: AiContextModelIdProvider,
  logger?: AiContextHandlerLogger,
): (payload: AiContextPreviewRequest) => Promise<AiContextPreviewResponse> {
  return async (payload) => {
    const startedAtMs = performance.now();
    const context = await builder.build({
      profileId: payload.profileId,
      period: payload.period,
      includeNotes: payload.includeNotes,
      modelId: await modelId(),
    });
    logger?.info('ai/context/preview', {
      period: periodLabel(payload.period),
      notes: payload.includeNotes,
      sections: context.sections.length,
      durationMs: Math.round(performance.now() - startedAtMs),
    });
    return { text: context.text, sections: [...context.sections], hash: context.contextHash };
  };
}
