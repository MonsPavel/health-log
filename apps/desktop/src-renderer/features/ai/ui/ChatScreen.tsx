/**
 * TASK-090 §2/§5/§10/§12/§13/§16: экран «Чат» (вкладка /ai) — лента истории
 * (инициализация ai/chat/list; user — справа акцент, assistant — слева нейтрал,
 * refusal — серый с info-иконкой, ChatBubble), поле ввода вопроса (textarea
 * 1–3 строки, Enter=отправить, Shift+Enter=перенос, кнопка «Отправить»), стрим
 * ответа в «виртуальном» assistant-бабле (append deltas, §10; финал — замена на
 * сохранённое сообщение через invalidate ['chat', pid], §12), «Стоп» во время
 * генерации (ввод disabled — двойная BUSY-превенция UI+сервер, §10/§13), выбор
 * периода (компонент периода 057-паттерн — те же radio-пресеты + custom-поля;
 * ЛОКАЛЬНЫЙ state, дефолт 30d — §5/§12: не URL, вкладка не владеет адресом),
 * «Очистить чат» с подтверждением («История будет удалена необратимо», §5),
 * несъёмный дисклеймер-футер (§2/§14; в content каждого assistant-ответа
 * дисклеймер добавляет use case 089 — экран дублирует его постоянным футером),
 * BUSY-тост «Дождитесь завершения текущей генерации» (§13), empty-state с
 * тремя чипами-подсказками (вставка в поле, не отправка — §5), CTA-карточка
 * «модель не настроена» (§5, критерий как 088 AC-5.4).
 *
 * МОДЕЛЬ (§5, прецедент InsightScreen): не настроена (нет modelId в prefs ИЛИ
 * выбранная не установлена) → CTA-карточка ВМЕСТО ввода (история/очистка/период
 * остаются); пока prefs/список не загружены — состояния не показываем (без
 * вспышки CTA, прецедент баннера §5 081).
 *
 * ПРЕРЫВАНИЕ (§13, прецедент 088): ai:status ready/failed своего requestId без
 * финала — ход не сохранён → блок ошибки с «Повторить» (повторная отправка того
 * же вопроса тем же периодом). Отмена «Стоп» — финал без messageId: виртуальная
 * пара исчезает (частичный ответ не сохраняется, §5 089).
 *
 * ГОНКИ (§15): скролл-якорь вниз при новых сообщениях/токенах — только если
 * пользователь у низа (порог 48px, прецедент SummaryView), через
 * requestAnimationFrame (без layout thrash).
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_INTERNAL_ERROR } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import { periodToStatsParam, type Period, type PeriodState } from '../../../lib/period';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { CustomRangeFields } from '../../measurement/ui/CustomRangeFields';
import { usePreferences } from '../../settings/model/use-preferences';
import { useAiModels } from '../api/use-ai-models';
import { ChatIpcError, useChatGeneration, useChatHistory, useClearChat } from '../api/use-chat';
import { ChatBubble } from './ChatBubble';
import { SuggestedQuestions } from './SuggestedQuestions';

/** Props экрана (§6): переход на вкладку «Модель» из CTA (§5, как 088). */
export interface ChatScreenProps {
  /** CTA «Модель не настроена» → вкладка «Модель» (владеет AiPage). */
  readonly onGoToModel: () => void;
}

/** Пункты периода экрана (§5: 057-паттерн «как в разборе»). */
const PERIOD_OPTIONS = ['7d', '30d', '90d', 'custom'] as const;

/** Ключи подписей периода — общие с журналом/разбором (один паттерн period). */
const PERIOD_KEY: Readonly<
  Record<
    Exclude<Period, 'all'>,
    | 'measurement.filters.period.7d'
    | 'measurement.filters.period.30d'
    | 'measurement.filters.period.90d'
    | 'measurement.filters.period.custom'
  >
> = {
  '7d': 'measurement.filters.period.7d',
  '30d': 'measurement.filters.period.30d',
  '90d': 'measurement.filters.period.90d',
  custom: 'measurement.filters.period.custom',
};

/** Максимум высоты textarea — 3 строки по 24px (§5 «1–3 строки»). */
const TEXTAREA_MAX_HEIGHT_PX = 72;

/** Экран «Чат» (§2). */
export function ChatScreen({ onGoToModel }: ChatScreenProps): JSX.Element {
  const { t } = useTranslation();
  const { showToast, showMessage } = useToast();
  // Период — ЛОКАЛЬНЫЙ state (§5/§12: не URL), дефолт 30d; общий контекст с разбором.
  const [periodState, setPeriodState] = useState<PeriodState>({ period: '30d' });
  const [question, setQuestion] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const history = useChatHistory(PROFILE_ID);
  const generation = useChatGeneration();
  const clearChat = useClearChat();
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const { prefs } = usePreferences();
  const { data: modelsData } = useAiModels();

  // «Сейчас» для custom-границ — момент смены периода (§13 046; локальный state).
  const nowUtcMs = useMemo(() => Date.now(), [periodState]);
  const periodParam = useMemo(
    () => periodToStatsParam(periodState, nowUtcMs),
    [periodState, nowUtcMs],
  );

  // AC «как 088»: критерий «настроена» — modelId выбран И эта модель установлена.
  // Пока данных нет — состояние неизвестно (без вспышки CTA, §5 081).
  const aiSettings = prefs?.aiSettings;
  const modelStateKnown = prefs !== undefined && modelsData !== undefined;
  const modelConfigured =
    aiSettings?.modelId !== undefined &&
    (modelsData?.models.some(
      (model) => model.descriptor.id === aiSettings.modelId && model.state === 'installed',
    ) ??
      false);

  const setPeriod = useCallback((period: Period): void => {
    if (period === 'custom') {
      setPeriodState((previous) => ({ ...previous, period: 'custom' }));
      return;
    }
    setPeriodState({ period });
  }, []);

  const setRange = useCallback((from: string | undefined, to: string | undefined): void => {
    setPeriodState({
      period: 'custom',
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  }, []);

  const streaming = generation.phase === 'streaming';

  /** Отправка (§5): Enter и кнопка — один путь; trim; BUSY — тост §17 chat.busy. */
  const submit = useCallback((): void => {
    const trimmed = question.trim();
    if (trimmed === '' || streaming) {
      return;
    }
    setQuestion('');
    void generation.send({ question: trimmed, period: periodParam }).catch((error: unknown) => {
      if (error instanceof ChatIpcError && error.dto.code === 'AI/BUSY') {
        // §13: BUSY-тост «Дождитесь завершения текущей генерации» (двойная
        // защита с disabled — §10); текст чата точнее каталога AI_BUSY.
        showMessage(t('ai.chat.busy'));
      } else if (error instanceof ChatIpcError) {
        showToast(error.dto);
      } else {
        showToast(APP_INTERNAL_ERROR);
      }
    });
  }, [question, streaming, generation, periodParam, showToast, showMessage, t]);

  /** Enter=отправить, Shift+Enter=перенос (§5); IME-композиция не отправляет. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  /** «Очистить чат» после подтверждения (§5/§13); clear идемпотентен (§13 089). */
  const handleClear = (): void => {
    setConfirmOpen(false);
    clearChat.mutate(undefined, {
      onError: (error: unknown) => {
        if (error instanceof ChatIpcError) {
          showToast(error.dto);
        } else {
          showToast(APP_INTERNAL_ERROR);
        }
      },
    });
  };

  // §5 «textarea 1–3 строки»: авто-рост до 3 строк, дальше — скролл внутри поля.
  useEffect(() => {
    const element = inputRef.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [question]);

  const messages = history.data?.messages ?? [];
  const feedEmpty =
    !history.isPending &&
    !history.isError &&
    messages.length === 0 &&
    generation.question === undefined;

  // §4/§15: скролл-якорь вниз при новых сообщениях/токенах — rAF, только если
  // пользователь у низа (ручной скролл вверх не дёргается, прецедент SummaryView).
  const feedTail = messages.length + (generation.question === undefined ? 0 : 2);
  useEffect(() => {
    const element = feedRef.current;
    if (element === null) {
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (!nearBottom) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const current = feedRef.current;
      if (current !== null) {
        current.scrollTop = current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [feedTail, generation.text]);

  return (
    <section data-testid="chat-screen" aria-label={t('ai.tabs.chat')}>
      {/* §5: период-контрол «как в разборе» — сегмент radio 057-паттерна; локальный
          state (§12), дефолт 30d; период уходит в КАЖДЫЙ ai/chat/send (§11). */}
      <fieldset data-testid="chat-period" className="mb-4 border-0 p-0">
        <legend className="text-sm text-accent">{t('measurement.filters.periodLabel')}</legend>
        <div className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((option) => (
            <label
              key={option}
              className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-base hover:bg-accent/10"
            >
              <input
                type="radio"
                name="chat-period"
                data-testid={`chat-period-${option}`}
                value={option}
                checked={periodState.period === option}
                onChange={() => setPeriod(option)}
                className="h-5 w-5 accent-[var(--hl-accent)]"
              />
              {t(PERIOD_KEY[option])}
            </label>
          ))}
        </div>
        {periodState.period === 'custom' && (
          <div className="mt-3">
            <CustomRangeFields from={periodState.from} to={periodState.to} onApply={setRange} />
          </div>
        )}
      </fieldset>

      {/* §16: лента — role="log" aria-live="polite" (новые сообщения объявляются). */}
      <div
        ref={feedRef}
        data-testid="chat-feed"
        role="log"
        aria-live="polite"
        aria-label={t('ai.tabs.chat')}
        className="mb-3 flex min-h-24 max-h-[28rem] flex-col gap-3 overflow-y-auto rounded-md border border-border p-3"
      >
        {messages.map((message) => (
          <ChatBubble
            key={message.id}
            role={message.role}
            content={message.content}
            refusalClass={message.refusalClass}
          />
        ))}
        {/* §12: оптимистичная пара — user-бабл сразу, стрим в виртуальном
            assistant-бабле (append deltas, §10); финал заменяет их сохранёнными.
            TASK-109 §13: стрим-бабл с aria-busy — polite-лента не озвучивает
            дельты токенов; на финале сохранённая пара вставляется в log —
            одно озвучивание целиком. */}
        {generation.question !== undefined ? (
          <>
            <ChatBubble role="user" content={generation.question} />
            <ChatBubble role="assistant" content={generation.text} busy />
          </>
        ) : null}
      </div>

      {/* §5: empty-state — подсказка + три чипа (вставка в поле, НЕ отправка). */}
      {feedEmpty ? (
        <div data-testid="chat-empty" className="mb-4">
          <p className="mb-2 text-sm text-muted">{t('ai.chat.emptyHint')}</p>
          <SuggestedQuestions onPick={setQuestion} />
        </div>
      ) : null}

      {/* §13: прерванный ход (без финала) — блок ошибки с «Повторить» (§5 088). */}
      {generation.interrupted ? (
        <div
          data-testid="chat-error"
          role="alert"
          className="mb-4 rounded-md border border-status-fail/40 bg-status-fail/10 px-3 py-2"
        >
          <p className="text-sm font-medium text-text">{t('ai.chat.errorInterrupted')}</p>
          <button
            type="button"
            data-testid="chat-retry"
            onClick={generation.retry}
            className="mt-2 min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text"
          >
            {t('ai.chat.retry')}
          </button>
        </div>
      ) : null}

      {/* AC «как 088»: модель не настроена → CTA-карточка вместо ввода (история
          и очистка остаются). Пока модель не известна — ни CTA, ни ввода. */}
      {modelStateKnown && !modelConfigured ? (
        <div
          data-testid="chat-model-cta"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{t('ai.chat.modelCta.title')}</p>
            <p className="mt-0.5 text-sm text-muted">{t('ai.chat.modelCta.body')}</p>
          </div>
          <button
            type="button"
            data-testid="chat-model-cta-go"
            onClick={onGoToModel}
            className="min-h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-semibold text-bg"
          >
            {t('ai.chat.modelCta.go')}
          </button>
        </div>
      ) : null}

      {modelConfigured ? (
        <div className="mb-2">
          <label htmlFor="chat-input" className="mb-1 block text-sm text-accent">
            {t('ai.chat.inputLabel')}
          </label>
          <div className="flex items-end gap-2">
            {/* §5: textarea 1–3 строки (авто-рост, максимум 3); §13: во время
                генерации ввод disabled (двойная BUSY-превенция с сервером). */}
            <textarea
              id="chat-input"
              ref={inputRef}
              data-testid="chat-input"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={streaming}
              rows={1}
              placeholder={t('ai.chat.placeholder')}
              className="min-h-11 flex-1 resize-none overflow-y-auto rounded-md border border-border bg-transparent px-3 py-2 text-base leading-6"
            />
            {streaming ? (
              <button
                type="button"
                data-testid="chat-stop"
                onClick={generation.stop}
                className="min-h-11 shrink-0 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text hover:bg-accent/10"
              >
                {t('ai.chat.stop')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="chat-send"
                onClick={submit}
                disabled={question.trim() === ''}
                className="min-h-11 shrink-0 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-80"
              >
                {t('ai.chat.send')}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* §2/§14: дисклеймер-футер несъёмный (текст общий с разбором — §17 089:
          тот же, что добавляет use case в каждый assistant-ответ). */}
      <footer data-testid="chat-disclaimer" role="note" className="mb-6 text-sm text-muted">
        <span className="font-semibold">{t('ai.insight.disclaimer')}</span>
      </footer>

      {/* §5: «Очистить чат» — видимая, с подтверждением (Radix AlertDialog,
          прецедент InsightScreen 088 / WipeFlow 073). */}
      <div className="mt-4 border-t border-border pt-4">
        <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialog.Trigger asChild>
            <button
              type="button"
              data-testid="chat-clear"
              className="min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text hover:bg-accent/10"
            >
              {t('ai.chat.clear')}
            </button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
            <AlertDialog.Content
              data-testid="chat-clear-dialog"
              className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-6 shadow-lg"
            >
              <AlertDialog.Title
                data-testid="chat-clear-title"
                className="text-lg font-semibold text-text"
              >
                {t('ai.chat.clearTitle')}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-sm text-text">
                {t('ai.chat.clearBody')}
              </AlertDialog.Description>
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="chat-clear-cancel"
                    className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                  >
                    {t('ai.chat.clearCancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="chat-clear-confirm"
                  disabled={clearChat.isPending}
                  onClick={handleClear}
                  className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-80"
                >
                  {t('ai.chat.clearConfirm')}
                </button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </section>
  );
}
