/**
 * TASK-089 §2/§5: AskChat — полный поток US-19 (арх. 07 §5 «короткая генерация
 * с контекстом периода»):
 *  (1) BUSY-гвардия (§9: ОБЩАЯ с резюме — одна генерация на приложение): свой
 *      слот + статус ОДНОГО движка; идущая генерация (в т.ч. резюме) → AI/BUSY
 *      ДО префильтра (порядок §5);
 *  (2) префильтр 086 — классификация САМОГО вопроса (в отличие от резюме, где
 *      идёт служебная формулировка): refusal → сохранить user+assistant-отказ
 *      с refusal_class БЕЗ LLM — история ведётся честно (§5); emergency —
 *      refusal_class 'emergency' (AC-5.1 строка 2);
 *  (3) контекст периода (083) с КЭШЕМ сборки (§5 «кэш по hash периода —
 *      переиспользование сборки»): hash доступен только ПОСЛЕ сборки, поэтому
 *      ключ кэша — канонический вход + data_version (hash-эквивалент: тот же
 *      вход и те же данные → байт-тот же контекст и hash); includeNotes=false
 *      (решение: заметки в чат-контекст не включаются, опции в канале нет —
 *      FR-5.5 требует явного opt-in);
 *  (4) history: последние CHAT_HISTORY_DEPTH=6 СООБЩЕНИЙ (§4, порта listRecent);
 *  (5) генерация: systemPrompt — чат-вариант 084 (та же политика + строка
 *      «это диалог…»), сообщения = [system, контекст, история, вопрос]; модель
 *      не выбрана → AI/ENGINE_NOT_CONFIGURED ТОЛЬКО на LLM-пути (refusal работает
 *      без модели); maxTokens 512 — конфиг-override движка (§15: ответы чата
 *      короче; деталь адаптера ProcessLlmEngine, в порту нет);
 *  (6) guard 085 на КАЖДЫЙ ответ (§14); replace → отказ-пара В ИСТОРИИ
 *      (чат-специфика против 087: пользователь спрашивал — история честная);
 *  (7) дисклеймер-футер (краткий §5/§17: текст общий с резюме) в КАЖДОМ
 *      assistant-ответе — инвариант §20 п.6; футер доставляется последним
 *      токен-событием и хранится в content (модель §7: отдельного поля нет);
 *  (8) append обоих (пара user+assistant одним ходом, created_at_utc — Clock);
 *  cancel: signal → done(cancelled) → частичный ответ НЕ сохраняется (§5 п.5 087).
 *
 * СОБЫТИЯ (§11): ai:token {requestId, text} — каждый чанк + футер; ai:status
 * busy/ready — пары к LLM-пути; финал 'ai/chat/result' {requestId, messageId?}
 * РОВНО ОДИН (messageId нет — ход не сохранён: cancel); сбой движка/репо
 * отклоняет execute — финал не эмитится (UI живёт по ai:status/ошибке канала).
 *
 * §14: контекст/ответ/история — PHI: в лог и события не пишутся (только
 * агрегаты §18); history 6 — ограничение инъекционного накопления. §15: кэш
 * сборки — микросекунды на hit. §18: лог `chat ask durationMs guard=?
 * refusal=?` — без текста; refusal-путь не трогает движок — BUSY у него тоже
 * проверяется первым (порядок §5), но модель не нужна.
 */
import { v7 as uuidV7 } from 'uuid';

import type { HlEventMap, StatsPeriodParam } from '@hl/contracts';
import { AppError, type Clock } from '@hl/kernel';

import type { ChatMessageRecord, ChatRepository } from './ports/chat-repository.js';
import type { AiContext, AiContextInput } from './ai-context-builder.js';
import {
  AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY,
  AI_SUMMARY_DISCLAIMER_TEXT,
  type GenerateSummaryLogger,
} from './generate-summary.js';
import {
  resolveSummaryPeriod,
  type SummaryModelMetaProvider,
  type SummaryNotify,
} from './generate-summary.js';
import { llmEngineBusyError, type LlmEngine } from './ports/llm-engine.js';
import { buildChatSystemPrompt } from './prompts/system-prompt.js';
import { DEFAULT_GUARDRAIL_POLICY, type RefusalClass } from '../domain/guardrail-policy.js';
import type { PrecheckService } from './precheck-service.js';
import type { ResponseGuard } from './response-guard.js';

/** Глубина истории диалога в СООБЩЕНИЯХ (§4: «последние 6 сообщений»). */
export const CHAT_HISTORY_DEPTH = 6;

/** Команда хода чата (§5/§11): {profileId, question, period} + requestId + cancel-сигнал. */
export interface AskChatCommand {
  /** Профиль-владелец (принудительный скоуп, арх. 08 §3). */
  readonly profileId: string;
  /** Вопрос пользователя (валидацию ≥2 ≤500 сделала схема канала, §13/§14). */
  readonly question: string;
  /** Период контекста: пресет TASK-044 или custom-границы (включительно). */
  readonly period: StatsPeriodParam;
  /** Корреляционный id стрима/финала (генерирует хендлер, §11). */
  readonly requestId: string;
  /** Кооперативная отмена (§5 п.5 087): aborted → движок закроет done(cancelled). */
  readonly signal?: AbortSignal;
}

/** Исход хода = payload финала 'ai/chat/result' (§11 дословно). */
export interface AskChatOutcome {
  readonly requestId: string;
  /** Есть — пара сохранена (happy/refusal/replace); нет — ход не сохранён (cancel). */
  readonly messageId?: string;
}

/** Зависимости (§5/§7): всё внедряет контейнер, тесты — подстановки (§19). */
export interface AskChatDeps {
  /** Сборка контекста периода (083; та же сборка, что у резюме — переиспользование §5). */
  readonly context: SummaryContextPort;
  /** Префильтр (086): классификация вопроса + эскалация криза. */
  readonly precheck: PrecheckService;
  /** Пост-фильтр (085): pass/replace после завершения стрима. */
  readonly guard: ResponseGuard;
  /** Движок LLM (порт 078) — ОДИН на приложение: слот занят и резюме, и чатом (§9). */
  readonly engine: LlmEngine;
  /** Хранилище истории (порт ниже, адаптер v7). */
  readonly repo: ChatRepository;
  /** Мета активной модели (prefs + манифест; '' — не выбрана). */
  readonly modelMeta: SummaryModelMetaProvider;
  /** Мост событий (§11). */
  readonly notify: SummaryNotify;
  /** Время: createdAtUtc (§19: FixedClock в тестах). */
  readonly clock: Clock;
  /** Логгер телеметрии (§18; боевой — createLogger('ai')), по умолчанию молчун. */
  readonly logger?: GenerateSummaryLogger;
  /** Локаль номеров экстренных служб для префильтра (§14 086); нет — ru. */
  readonly locale?: string;
  /**
   * Текущий data_version — участник ключа кэша сборки контекста (см. шапку (3));
   * боевой — insightRepo.currentDataVersion; нет — кэш по входу (тесты).
   */
  readonly dataVersion?: () => Promise<number>;
}

/** Поверхность сборщика контекста (структурно AiContextBuilder — §19 подмены). */
export interface SummaryContextPort {
  build(input: AiContextInput): Promise<AiContext>;
}

/** Запись кэша сборки (§5): вход + data_version → готовый AiContext. */
interface ContextMemo {
  readonly key: string;
  readonly dataVersion: number;
  readonly context: AiContext;
}

/** Дисклеймер-футер ответа с разделителем (§5 «краткий»; текст — общий с резюме §17). */
const FOOTER_TEXT = `\n\n${AI_SUMMARY_DISCLAIMER_TEXT}`;

/**
 * AskChat (§2): execute(command) → исход-финал; события стрима уходят notify'ем
 * по ходу. Ошибки: наружу только AppError (AI/BUSY — слот §9, AI/ENGINE_NOT_
 * CONFIGURED — модель не выбрана на LLM-пути, AI/* движка, STORAGE/* репозитория).
 */
export class AskChat {
  private readonly deps: AskChatDeps;

  /** Слот хода (§9): undefined — свободен; второй execute до финала → AI/BUSY. */
  private activeRequest: string | undefined;

  /** Кэш сборки контекста (§5) — последний построенный контекст. */
  private memo: ContextMemo | undefined;

  constructor(deps: AskChatDeps) {
    this.deps = deps;
  }

  /**
   * Свободен ли слот хода (§9): хендлер вызывает ПЕРЕД ответом {requestId} —
   * второй send получает AI/BUSY как отказ канала (ApiFailure), а не тишину
   * фонового потока. Конфликт с резюме закрывает статус ОБЩЕГО движка (§9):
   * занятый резюме движок → BUSY ДО ответа {requestId} (TASK-090 §20: UI
   * показывает BUSY-тост; без проверки здесь хендлер отвечал бы ok, а execute
   * отклонялся бы в фоне без событий — молчаливое зависание стрима). Гонок
   * isBusy/execute нет — обе синхронны в одном тике (прецедент
   * generate-summary.isBusy); гард execute ниже остаётся задним страхом.
   */
  isBusy(): boolean {
    return this.activeRequest !== undefined || this.deps.engine.status().busy;
  }

  /** Полный поток US-19 (§5): порядок шагов — шапка; финал эмитится ровно один. */
  async execute(command: AskChatCommand): Promise<AskChatOutcome> {
    // §9 BUSY-гвардия (порядок §5: ДО префильтра): (а) свой слот — синхронная
    // фиксация до первого await (гонки двух вызовов); (б) общий с резюме ресурс —
    // ОДИН движок: идущая генерация видна через его статус.
    if (this.activeRequest !== undefined || this.deps.engine.status().busy) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок — AppError (TASK-006; прецедент generate-summary)
      throw llmEngineBusyError();
    }
    this.activeRequest = command.requestId;
    const startedAtMs = Date.now();
    let busySent = false;

    try {
      const meta = await this.deps.modelMeta();
      const resolved = resolveSummaryPeriod(command.period, this.deps.clock);

      // (3) Контекст периода (кэш сборки §5) — stats нужны префильтру (§13 086).
      const context = await this.buildContextCached({
        profileId: command.profileId,
        period: command.period,
        includeNotes: false, // решение §5: заметки в чат-контекст не включаются (FR-5.5)
        modelId: meta.modelId,
      });

      // (2) Префильтр 086: классификация САМОГО вопроса + эскалация криза.
      const precheck = this.deps.precheck.check(command.question, {
        stats: context.stats,
        locale: this.deps.locale,
      });
      if (precheck !== undefined) {
        const refusalClass =
          precheck.kind === 'refusal' ? precheck.refusalClass : ('emergency' as const);
        // Отказ — готовый текст БЕЗ LLM (AC-5.1); история ведётся честно (§5).
        // Футер — токен-событие ПЕРЕД сохранением: пользователь видит ровно то,
        // что попадёт в историю (конкатенация токенов == content, §20 п.6).
        this.deps.notify('ai:token', { requestId: command.requestId, text: precheck.text });
        this.deps.notify('ai:token', { requestId: command.requestId, text: FOOTER_TEXT });
        const messageId = await this.appendPair(command, refusalClass, precheck.text);
        this.log('chat ask', {
          durationMs: this.durationMs(startedAtMs),
          guard: '-',
          refusal: refusalClass,
        });
        return this.finish({ requestId: command.requestId, messageId });
      }

      // (5) LLM-путь: модель обязательна (§8 арх. 07; refusal выше работал и без неё).
      if (meta.modelId === '') {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок — AppError (TASK-006; прецедент generate-summary)
        throw AppError.of('AI/ENGINE_NOT_CONFIGURED', AI_ENGINE_NOT_CONFIGURED_MESSAGE_KEY, {
          requestId: command.requestId,
        });
      }

      // (4) История диалога: последние 6 СООБЩЕНИЙ (§4; ограничение инъекций §14).
      const history = await this.deps.repo.listRecent(command.profileId, CHAT_HISTORY_DEPTH);

      const systemPrompt = buildChatSystemPrompt(
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
      // Сборка (§5): system + контекст периода (КАЖДЫЙ вопрос, §4) + история + вопрос.
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: context.text },
        ...history.map((record) => ({ role: record.role, content: record.content })),
        { role: 'user' as const, content: command.question },
      ];

      this.deps.notify('ai:status', { requestId: command.requestId, state: 'busy' });
      busySent = true;
      await this.deps.engine.ensureModel(meta.modelId);

      let answer = '';
      let tokens = 0;
      let finish: 'stop' | 'cancelled' | undefined;
      // Первый финальный чанк фиксирует исход (§22 087): цикл завершается на первом done.
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
        // Отмена: частичный ответ НЕ сохраняется (§5 п.5 087); финал без messageId.
        this.log('chat/cancelled', {
          model: meta.modelId,
          durationMs: this.durationMs(startedAtMs),
          tokens,
        });
        return this.finish({ requestId: command.requestId });
      }

      // (6) Пост-фильтр 085 (§14: guard на КАЖДЫЙ ответ; вызов один после стрима).
      const guardResult = this.deps.guard.check(answer);
      const refusalClass = guardResult.action === 'replace' ? guardResult.refusalClass : undefined;
      const answerText = guardResult.action === 'replace' ? guardResult.text : answer;

      // (7)/(8) Футер (§20 п.6) — токен-событие + часть сохранённого content (§7).
      this.deps.notify('ai:token', { requestId: command.requestId, text: FOOTER_TEXT });
      const messageId = await this.appendPair(command, refusalClass, answerText);
      this.log('chat ask', {
        model: meta.modelId,
        durationMs: this.durationMs(startedAtMs),
        tokens,
        guard: guardResult.action,
        refusal: refusalClass ?? '-',
      });
      return this.finish({ requestId: command.requestId, messageId });
    } finally {
      // ai:status ready — пара к busy LLM-пути (UI гасит индикатор; §11).
      if (busySent) {
        this.deps.notify('ai:status', { requestId: command.requestId, state: 'ready' });
      }
      this.activeRequest = undefined; // слот освобождён в ЛЮБОМ исходе (§9 087)
    }
  }

  /**
   * Контекст с кэшем сборки (§5): тот же канонический вход + те же данные
   * (data_version) → готовый AiContext без повторной сборки. Контекст-hash —
   * участник ключа по смыслу, но известен только ПОСЛЕ сборки, поэтому ключ —
   * канонический вход + data_version (hash-эквивалент: сборка детерминирована
   * входом и данными, 083 §13).
   */
  private async buildContextCached(input: AiContextInput): Promise<AiContext> {
    const key = JSON.stringify([input.profileId, input.period, input.includeNotes, input.modelId]);
    const dataVersion = this.deps.dataVersion !== undefined ? await this.deps.dataVersion() : 0;
    if (this.memo !== undefined && this.memo.key === key && this.memo.dataVersion === dataVersion) {
      return this.memo.context;
    }
    const context = await this.deps.context.build(input);
    this.memo = { key, dataVersion, context };
    return context;
  }

  /**
   * Сохранение пары (§5 «append обоих»): user + assistant (с футером §20 п.6 и
   * refusal_class у refusal/replace-ответов, §7). Один ход — две записи с одним
   * created_at_utc (Clock); порядок пары в одной мс восстанавливает listRecent
   * (rowid-тай-брейк адаптера).
   */
  private async appendPair(
    command: AskChatCommand,
    refusalClass: RefusalClass | undefined,
    answerText: string,
  ): Promise<string> {
    const createdAtUtc = this.deps.clock.nowMs();
    const userRecord: ChatMessageRecord = {
      id: uuidV7(),
      profileId: command.profileId,
      role: 'user',
      content: command.question,
      createdAtUtc,
    };
    const assistantRecord: ChatMessageRecord = {
      id: uuidV7(),
      profileId: command.profileId,
      role: 'assistant',
      content: `${answerText}${FOOTER_TEXT}`,
      ...(refusalClass === undefined ? {} : { refusalClass }),
      createdAtUtc,
    };
    await this.deps.repo.append(userRecord);
    await this.deps.repo.append(assistantRecord);
    return assistantRecord.id;
  }

  /** Единая финализация (§22 087): финал-событие ровно один, исход — возврат. */
  private finish(outcome: AskChatOutcome): AskChatOutcome {
    const payload: HlEventMap['ai/chat/result'] =
      outcome.messageId === undefined
        ? { requestId: outcome.requestId }
        : { requestId: outcome.requestId, messageId: outcome.messageId };
    this.deps.notify('ai/chat/result', payload);
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
