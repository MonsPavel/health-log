/**
 * TASK-087 §2/§5: GenerateSummary — полный поток UC-03 (арх. 07 §5):
 *  (1) AiContextBuilder → детерминированный контекст периода + contextHash;
 *  (2) префильтр 086 → refusal → отказ-резюме НЕ сохраняется (всегда свежий
 *      пересчёт — дёшево), ответ-стрим из шаблона;
 *  (3) кэш findByContextHash → hit: вернуть из кэша + stale-расчёт (data_version §7);
 *  (4) miss: LlmEngine.ensureModel → complete(systemPrompt+userPrompt(ctx.text)) →
 *      агрегация стрима → токены-события (батчинг реального пути — клиент 076:
 *      чанки порта приходят уже пачками 50 мс, use case доставляет их renderer'у
 *      как есть; fake-режим — по «словам», dev/e2e) → done → ResponseGuard.check →
 *      пост-обработка (период-подпись + дисклеймер — ОТДЕЛЬНЫЕ поля, не content_md)
 *      → save (data_version текущий на момент сохранения);
 *  (5) cancel: signal → done(cancelled) → НЕ сохранять.
 *
 * РЕШЕНИЯ СПЕЦИФИКАЦИИ, зафиксированные здесь:
 *  - отказ 086 не сохраняется (§5); guard-replace тоже «не резюме» — не сохраняется
 *    (§9: пользователь видит отказ в стриме, в резюме его нет; чат-история — 089);
 *  - BUSY-гвардия §9: у use case СВОЙ слот генерации — второй execute до финала
 *    первого → AppError AI/BUSY (серверная защита; cache-hit/refusal тоже ждут
 *    освобождения слота — один поток за раз, UI блокирует кнопку);
 *  - модель не выбрана (modelId '' из prefs) → AI/ENGINE_NOT_CONFIGURED ДО движка
 *    (§8 арх. 07: без модели остальное приложение полноценно; cache-hit при этом
 *    работает — модель нужна только на miss-пути);
 *  - финализация идемпотентна (§22): исход фиксирует ПЕРВЫЙ финальный чанк стрима
 *    (done(stop)/done(cancelled)); поздние abort исхода не меняют (гонка cancel vs
 *    done) — потребление стрима завершается на первом done;
 *  - refusal «вопроса» для префильтра: UC-03 — не вопрос, а разбор периода; в
 *    префильтр 086 идёт служебная формулировка SUMMARY_SERVICE_QUESTION (не
 *    матчится ни одним классом политики 082) — для резюме срабатывает ТОЛЬКО
 *    порог малых данных (криз периода в резюме не эскалирует: срочную панель даёт
 *    TASK-041, а система-промпт 084 обязан упомянуть критические значения; вопрос
 *    о состоянии — это чат 089).
 *
 * СОБЫТИЯ (§11): ai:token {requestId, text} — каждый чанк стрима; ai:status
 * {requestId, state} — busy перед ensureModel / ready после финала miss-пути;
 * 'ai/summary/result' {requestId, summaryId?, cached, stale} — финал РОВНО ОДИН
 * (не ошибка: сбой стрима/движка отклоняет execute — финал не эмитится, UI живёт
 * по ai:status/ошибке канала). requestId генерирует хендлер (слой IPC) и передаёт
 * в команде — ключ корреляции токенов и финала.
 *
 * Границы периода записи (§7 «period»): пресет — от Clock (now-Nд .. now), custom —
 * как есть, 'all' — сентинелы {0, now} (метаданные latest-запроса §12; пресеты
 * «движутся» вместе с now — вчерашний '7d' честно даёт latest undefined).
 *
 * §14: контекст/ответ — PHI: в лог и события не пишутся (только агрегаты §18);
 * §15: cache-hit — два чтения БД, микросекунды; полный путь замеряется durationMs.
 * §17: disclaimerText/periodText — RU-константы main (LLM-слой мимо i18n-каталога,
 * прецедент 084/086); дисклеймер согласован с ОБЯЗАТЕЛЬНО промпта 084 (тест).
 */
import { v7 as uuidV7 } from 'uuid';

import type { HlEventMap, StatsPeriodParam } from '@hl/contracts';
import { AppError, Instant, type Clock } from '@hl/kernel';

import type { AiContext, AiContextInput } from './ai-context-builder.js';
import { PROMPT_TEMPLATE_VERSION } from './ai-context-builder.js';
import { DEFAULT_GUARDRAIL_POLICY } from '../domain/guardrail-policy.js';
import type {
  InsightRepository,
  SummaryPeriod,
  SummaryRecord,
} from './ports/insight-repository.js';
import { llmEngineBusyError, type LlmEngine } from './ports/llm-engine.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import type { PrecheckService } from './precheck-service.js';
import type { ResponseGuard } from './response-guard.js';

/** Версия шаблона промпта — для телеметрии §18 (источник — 084 через ре-экспорт 083). */
const PROMPT_VERSION: string = PROMPT_TEMPLATE_VERSION;

/** Несъёмный дисклеймер (§5/§17: RU-константа main, согласована с промптом 084 — тест §20 п.6). */
export const AI_SUMMARY_DISCLAIMER_TEXT = 'Это не медицинская консультация.';

/**
 * Ключ i18n «модель не выбрана» (конвенция арх. 05 §29; тексты — TASK-101). Строка
 * дублирует константу адаптера llm-process-client (076): application не импортирует
 * adapters (depcruise) — единство строки закреплено тестами кода ошибки AI/ENGINE_
 * NOT_CONFIGURED у обоих.
 */
export const AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY = 'errors.AI_ENGINE_NOT_CONFIGURED';

/** Миллисекунды суток (пресеты периода — семантики TASK-044). */
const MS_PER_DAY = 86_400_000;

/** Длительность пресетов периода (to = ∞; §9 054). */
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

/** RU-подписи пресетов (§17: период-подпись — RU-константа main). */
const PRESET_LABELS = {
  '7d': 'последние 7 дней',
  '30d': 'последние 30 дней',
  '90d': 'последние 90 дней',
} as const;

/** Подпись периода «весь журнал» (§17). */
const ALL_PERIOD_LABEL = 'весь журнал наблюдений';

/**
 * Служебная формулировка запроса резюме для префильтра 086 (см. шапку): НЕ матчится
 * классами политики 082 (нет лексики лекарств/доз/диагнозов/кризов) — в поток
 * резюме отказ даёт только порог малых данных. Фиксируется тестом-сверкой (§13).
 */
export const SUMMARY_SERVICE_QUESTION = 'Объясни мою динамику показателей за период';

/** Команда генерации (§5): {profileId, period, includeNotes} + requestId хендлера + cancel-сигнал. */
export interface GenerateSummaryCommand {
  /** Профиль-владелец (принудительный скоуп, арх. 08 §3). */
  readonly profileId: string;
  /** Период: пресет TASK-044 или custom-границы TASK-046 (включительно). */
  readonly period: StatsPeriodParam;
  /** Заметки в контексте — ТОЛЬКО по явной опции (FR-5.5, §14; участник hash 083). */
  readonly includeNotes: boolean;
  /** Корреляционный id стрима/финала (генерирует хендлер, §11). */
  readonly requestId: string;
  /** Кооперативная отмена (§5 п.5): aborted → движок закроет done(cancelled). */
  readonly signal?: AbortSignal;
}

/** Исход генерации = payload финала 'ai/summary/result' (§11 дословно). */
export interface GenerateSummaryOutcome {
  readonly requestId: string;
  /** Есть — резюме сохранено (miss→done(ok)); нет — «не резюме»/кэш без id не бывает. */
  readonly summaryId?: string;
  readonly cached: boolean;
  /** Актуален ли stale-бейдж для этой записи (после свежей генерации — всегда false). */
  readonly stale: boolean;
}

/** Мета активной модели (§4 арх. 07: версия модели фиксируется в каждом резюме). */
export interface SummaryModelMeta {
  /** Активная модель (prefs.aiSettings.modelId); '' — не выбрана (→ ENGINE_NOT_CONFIGURED на miss). */
  readonly modelId: string;
  /** Версия из манифеста 079; '' — дескриптор не найден (кастомный id). */
  readonly modelVersion: string;
}

/** Источник мета модели (боевой — контейнер: prefs + реестр манифеста). */
export type SummaryModelMetaProvider = () => Promise<SummaryModelMeta>;

/** Доставка событий renderer'у (§11; боевой мост — broadcastToWindows, прецедент 075/076). */
export type SummaryNotify = <K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]) => void;

/** Минимальная поверхность логгера (§18; прецедент PrecheckLogger 086). */
export interface GenerateSummaryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Поверхность сборщика контекста (структурно AiContextBuilder — §19 подмены). */
export interface SummaryContextPort {
  build(input: AiContextInput): Promise<AiContext>;
}

/** Зависимости (§5/§7): всё внедряет контейнер, тесты — подстановки (§19). */
export interface GenerateSummaryDeps {
  /** Сборка контекста периода (083). */
  readonly context: SummaryContextPort;
  /** Префильтр (086): порог малых данных для резюме (см. шапку). */
  readonly precheck: PrecheckService;
  /** Пост-фильтр (085): pass/replace после завершения стрима. */
  readonly guard: ResponseGuard;
  /** Движок LLM (порт 078). */
  readonly engine: LlmEngine;
  /** Хранилище резюме (порт ниже, адаптер v6). */
  readonly repo: InsightRepository;
  /** Мета активной модели (prefs + манифест). */
  readonly modelMeta: SummaryModelMetaProvider;
  /** Мост событий (§11). */
  readonly notify: SummaryNotify;
  /** Время: границы пресетов, createdAtUtc (§19: FixedClock в тестах). */
  readonly clock: Clock;
  /** Логгер телеметрии (§18; боевой — createLogger('ai')), по умолчанию молчун. */
  readonly logger?: GenerateSummaryLogger;
  /** Локаль номеров экстренных служб для префильтра (§14 086); нет — ru. */
  readonly locale?: string;
}

/** Разрешённый период + подпись (единый источник для use case и latest-хендлера §12). */
export interface ResolvedSummaryPeriod {
  /** Границы записи (сентинелы ∞ — см. шапку). */
  readonly period: SummaryPeriod;
  /** Подпись «Период анализа» (§17): в system prompt 084 и в запись. */
  readonly periodText: string;
}

/** Настенная дата 'DD.MM.YYYY' момента в собственном поясе приложения (§17). */
function wallDateOf(utcMs: number, tzOffsetMin: number): string {
  const iso = Instant.toIso({ utcMs, tzOffsetMin }).slice(0, 10); // 'YYYY-MM-DD'
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * Разрешение периода (§7/§13): пресет — от now (Clock), custom — как есть, 'all' —
 * сентинелы {0, now}. Подпись — RU-константа пресета либо диапазон настенных дат.
 * Чистая функция времени — переиспользуется latest-хендлером (§12, без дрейфа).
 */
export function resolveSummaryPeriod(
  period: StatsPeriodParam,
  clock: Clock,
): ResolvedSummaryPeriod {
  const nowMs = clock.nowMs();
  if (period === 'all') {
    return { period: { fromUtcMs: 0, toUtcMs: nowMs }, periodText: ALL_PERIOD_LABEL };
  }
  if (typeof period === 'string') {
    return {
      period: { fromUtcMs: nowMs - PRESET_DAYS[period] * MS_PER_DAY, toUtcMs: nowMs },
      periodText: PRESET_LABELS[period],
    };
  }
  const tz = clock.tzOffsetMin();
  return {
    period: { fromUtcMs: period.fromUtcMs, toUtcMs: period.toUtcMs },
    periodText: `${wallDateOf(period.fromUtcMs, tz)}–${wallDateOf(period.toUtcMs, tz)}`,
  };
}

/**
 * GenerateSummary (§2): execute(command) → исход-финал; события стрима уходят
 * notify'ем по ходу. Ошибки: наружу только AppError (AI/BUSY — слот §9,
 * AI/ENGINE_NOT_CONFIGURED — модель не выбрана, AI/* движка, STORAGE/* репозитория).
 */
export class GenerateSummary {
  private readonly deps: GenerateSummaryDeps;

  /** Слот генерации (§9): undefined — свободен; второй execute до финала → AI/BUSY. */
  private activeRequest: string | undefined;

  constructor(deps: GenerateSummaryDeps) {
    this.deps = deps;
  }

  /**
   * Свободен ли слот генерации (§9): хендлер вызывает ПЕРЕД ответом {requestId} —
   * второй generate получает AI/BUSY как отказ канала (ApiFailure), а не тишину
   * фонового потока. Гонки между isBusy и execute нет: обе синхронны в одном тике;
   * слот-гард execute остаётся задним страхом.
   */
  isBusy(): boolean {
    return this.activeRequest !== undefined;
  }

  /** Полный поток UC-03 (§5): порядок шагов — шапка; финал эмитится ровно один. */
  async execute(command: GenerateSummaryCommand): Promise<GenerateSummaryOutcome> {
    // §9 BUSY-гвардия: синхронная фиксация слота ДО первого await (гонки двух вызовов).
    if (this.activeRequest !== undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок — AppError (TASK-006; прецедент llm-engine/fake-llm-engine)
      throw llmEngineBusyError();
    }
    this.activeRequest = command.requestId;
    const startedAtMs = Date.now();
    let busySent = false;

    try {
      const meta = await this.deps.modelMeta();
      const resolved = resolveSummaryPeriod(command.period, this.deps.clock);
      const context = await this.deps.context.build({
        profileId: command.profileId,
        period: command.period,
        includeNotes: command.includeNotes,
        modelId: meta.modelId,
      });

      // (2) Префильтр 086 (см. шапку: для резюме срабатывает порог малых данных).
      const precheck = this.deps.precheck.check(SUMMARY_SERVICE_QUESTION, {
        stats: context.stats,
        locale: this.deps.locale,
      });
      if (precheck !== undefined) {
        // Отказ-резюме НЕ сохраняется (решение §5): мгновенный стрим шаблона.
        this.deps.notify('ai:token', { requestId: command.requestId, text: precheck.text });
        return this.finish({ requestId: command.requestId, cached: false, stale: false });
      }

      // (3) Кэш по contextHash (FR-5.7): hit — движок не трогается (§20 п.2 spy-тест).
      const cachedRecord = await this.deps.repo.findByContextHash(
        command.profileId,
        context.contextHash,
      );
      if (cachedRecord !== undefined) {
        const currentVersion = await this.deps.repo.currentDataVersion();
        const stale = cachedRecord.dataVersion < currentVersion;
        this.log('ai/summary/generate', {
          model: meta.modelId,
          durationMs: this.durationMs(startedAtMs),
          tokens: 0,
          cached: true,
          guard: '-',
        });
        return this.finish({
          requestId: command.requestId,
          summaryId: cachedRecord.id,
          cached: true,
          stale,
        });
      }

      // (4) Miss-путь: модель обязательна (§8 арх. 07; cache-hit выше работал и без неё).
      if (meta.modelId === '') {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок — AppError (TASK-006; прецедент llm-process-client)
        throw AppError.of('AI/ENGINE_NOT_CONFIGURED', AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY, {
          requestId: command.requestId,
        });
      }

      const systemPrompt = buildSystemPrompt(
        // Политика — единственный источник правил (арх. 07 §4 эшелон 1, прецедент 084).
        DEFAULT_GUARDRAIL_POLICY,
        {
          periodText: resolved.periodText,
          hasGaps: context.gaps.length > 0,
          insufficientData:
            context.stats.insufficientData.tooFewMeasurements ||
            context.stats.insufficientData.tooFewDays,
        },
      );
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: context.text },
      ];

      this.deps.notify('ai:status', { requestId: command.requestId, state: 'busy' });
      busySent = true;
      await this.deps.engine.ensureModel(meta.modelId);

      let answer = '';
      let tokens = 0;
      let finish: 'stop' | 'cancelled' | undefined;
      // Первый финальный чанк фиксирует исход (§22): цикл завершается на первом done —
      // поздние чанки/abort исхода не меняют.
      for await (const chunk of this.deps.engine.complete({
        messages,
        signal: command.signal ?? new AbortController().signal,
      })) {
        if ('done' in chunk) {
          finish = chunk.done;
          break;
        }
        tokens += 1;
        answer += chunk.delta;
        this.deps.notify('ai:token', { requestId: command.requestId, text: chunk.delta });
      }

      if (finish === 'cancelled') {
        // (5) Отмена: частичный ответ НЕ сохраняется (§5 п.5); финал — «не резюме».
        this.log('ai/summary/cancelled', {
          model: meta.modelId,
          durationMs: this.durationMs(startedAtMs),
          tokens,
        });
        return this.finish({ requestId: command.requestId, cached: false, stale: false });
      }

      // Пост-фильтр 085 (§9: вызов один раз после завершения стрима).
      const guardResult = this.deps.guard.check(answer);
      if (guardResult.action === 'replace') {
        // Решение §9: replace-ответ «не резюме» — НЕ сохраняется; в стриме пользователь
        // уже видел исходный текст, фиксация исхода — финал без summaryId (§14: лог
        // replace-события делает сам ResponseGuard, текст ответа в лог не идёт).
        this.log('ai/summary/generate', {
          model: meta.modelId,
          durationMs: this.durationMs(startedAtMs),
          tokens,
          cached: false,
          guard: 'replace',
        });
        return this.finish({ requestId: command.requestId, cached: false, stale: false });
      }

      // Сохранение только при done(ok) + pass (§5/§9): data_version — ТЕКУЩИЙ (§5 save).
      const dataVersion = await this.deps.repo.currentDataVersion();
      const record: SummaryRecord = {
        id: uuidV7(),
        profileId: command.profileId,
        period: resolved.period,
        contextHash: context.contextHash,
        modelId: meta.modelId,
        modelVersion: meta.modelVersion,
        dataVersion,
        contentMd: answer,
        disclaimerText: AI_SUMMARY_DISCLAIMER_TEXT,
        periodText: resolved.periodText,
        createdAtUtc: this.deps.clock.nowMs(),
      };
      await this.deps.repo.save(record);
      this.log('ai/summary/generate', {
        model: meta.modelId,
        durationMs: this.durationMs(startedAtMs),
        tokens,
        cached: false,
        guard: 'pass',
        promptVersion: PROMPT_VERSION,
        promptChars: systemPrompt.length,
      });
      return this.finish({
        requestId: command.requestId,
        summaryId: record.id,
        cached: false,
        stale: false,
      });
    } finally {
      // ai:status ready — пары к busy miss-пути (UI гасит индикатор; §11).
      if (busySent) {
        this.deps.notify('ai:status', { requestId: command.requestId, state: 'ready' });
      }
      this.activeRequest = undefined; // слот освобождён в ЛЮБОМ исходе (тест 13)
    }
  }

  /** Единая финализация (§22): финал-событие ровно один, исход — возвращаемое значение. */
  private finish(outcome: GenerateSummaryOutcome): GenerateSummaryOutcome {
    // payload иммутабелен (readonly карты событий) — форма собирается целиком.
    const payload: HlEventMap['ai/summary/result'] =
      outcome.summaryId === undefined
        ? { requestId: outcome.requestId, cached: outcome.cached, stale: outcome.stale }
        : {
            requestId: outcome.requestId,
            summaryId: outcome.summaryId,
            cached: outcome.cached,
            stale: outcome.stale,
          };
    this.deps.notify('ai/summary/result', payload);
    return outcome;
  }

  private durationMs(startedAtMs: number): number {
    return Date.now() - startedAtMs;
  }

  /** Телеметрия §18: агрегаты без текста (PHI). */
  private log(message: string, meta: Record<string, unknown>): void {
    this.deps.logger?.info(message, meta);
  }
}
