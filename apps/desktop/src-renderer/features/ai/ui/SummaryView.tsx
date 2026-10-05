/**
 * TASK-088 §5/§10/§14/§16: представление резюме/стрима. Компонент презентационный —
 * все состояния выражены пропами:
 *  - текст — как есть, pre-wrap (решение §5: без md-парсера в MVP);
 *  - НЕСЪЁМНЫЙ футер (AC-5.2, §14 «контракт полей; тест отсутствия способа скрыть»):
 *    дисклеймер + «Период анализа: …» рендерятся ВСЕГДА — пропа скрытия нет
 *    (тест — матрица всех комбинаций пропов);
 *  - отказ-ответ — серый блок с info-иконкой (стильное различение от разбора, §10);
 *    текст отказа приходит стримом (086) — блок лишь помечает его визуально;
 *  - стейлс: жёлтый бейдж НАД текстом, клик = перегенерация (§10/§12);
 *  - «из кэша» — финал cache-hit (FR-5.7);
 *  - стрим: дельты НЕ озвучиваются (aria-live off + aria-busy), финал — polite
 *    с перемонтированным текст-узлом: одно озвучивание целиком (TASK-109 §13),
 *    авто-скролл вниз ТОЛЬКО если пользователь у низа — ручной скролл вверх не
 *    дёргается (§10).
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/** Props представления (§5). */
export interface SummaryViewProps {
  /** Текст разбора (стрим или contentMd сохранённой записи). */
  readonly text: string;
  /** Идёт генерация: aria-live polite + авто-скролл (§16/§10). */
  readonly streaming?: boolean;
  /** Ответ из кэша (финал cache-hit) — бейдж «из кэша» (§5). */
  readonly cached?: boolean;
  /** Отказ-ответ (финал без summaryId) — серый блок с иконкой info (§10). */
  readonly refusal?: boolean;
  /** Данные изменились после генерации (latest.stale, §12) — жёлтый бейдж. */
  readonly stale?: boolean;
  /** Текст дисклеймера (DTO записи или i18n для живого стрима, §17 087). */
  readonly disclaimerText: string;
  /** Подпись периода (DTO или локальная подпись состояния периода). */
  readonly periodText: string;
  /** Клик по стейлс-бейджу = перегенерация (§10). */
  readonly onStaleClick?: () => void;
}

/** Иконка info отказ-блока (декоративная — aria-hidden, смысл в тексте). */
function RefusalIcon(): JSX.Element {
  return (
    <svg
      data-testid="insight-refusal-icon"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="mt-0.5 h-5 w-5 shrink-0"
    >
      <path
        fillRule="evenodd"
        d="M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a1 1 0 0 0 0 2v3a1 1 0 1 0 2 0v-3a1 1 0 0 0 0-2V9Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Представление резюме/стрима (§2): бейджи → текст → несъёмный футер. */
export function SummaryView({
  text,
  streaming = false,
  cached = false,
  refusal = false,
  stale = false,
  disclaimerText,
  periodText,
  onStaleClick,
}: SummaryViewProps): JSX.Element {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // §10: авто-скролл только когда пользователь у низа (порог 48px) — при ручном
  // скролле вверх текст не «убегает».
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || !streaming) {
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (nearBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text, streaming]);

  return (
    <div data-testid="insight-summary">
      {stale ? (
        <button
          type="button"
          data-testid="insight-stale-badge"
          onClick={onStaleClick}
          className="mb-3 flex w-full items-center gap-2 rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-left text-sm font-semibold text-text hover:bg-status-warn/20"
        >
          {t('ai.insight.staleBadge')}
        </button>
      ) : null}

      <div
        ref={scrollRef}
        data-testid="insight-summary-text"
        /*
         * TASK-109 §13 (NVDA-кейс): во время стрима регион НЕ озвучивает дельты
         * (aria-live="off" + aria-busy — иначе NVDA читает текст «буква-за-буквой»
         * на каждом токене); на финале регион снова polite, а текст-узел
         * ПЕРЕМОНТИРОВАН (data-phase/key по фазе) — вставка узла в polite-регион
         * озвучивается ОДИН раз, целиком (в т.ч. стоп/кэш/отказ, где статус-тоста
         * нет). Сохранённый разбор рендерится в polite-регионе сразу — монтирование
         * региона само по себе не объявляется.
         */
        aria-live={streaming ? 'off' : 'polite'}
        aria-busy={streaming || undefined}
        data-kind={refusal ? 'refusal' : undefined}
        className={`max-h-96 overflow-y-auto rounded-md border p-3 ${
          refusal ? 'border-border bg-surface text-muted' : 'border-border bg-bg text-text'
        }`}
      >
        {refusal ? (
          <div
            key={streaming ? 'stream' : 'final'}
            data-phase={streaming ? 'stream' : 'final'}
            className="flex items-start gap-2"
          >
            <RefusalIcon />
            <div className="whitespace-pre-wrap break-words text-sm">{text}</div>
          </div>
        ) : (
          <div
            key={streaming ? 'stream' : 'final'}
            data-phase={streaming ? 'stream' : 'final'}
            className="whitespace-pre-wrap break-words text-base"
          >
            {text}
          </div>
        )}
      </div>

      {cached ? (
        <span
          data-testid="insight-cached-badge"
          className="mt-2 inline-block rounded-md border border-border bg-accent/10 px-2 py-0.5 text-sm text-text"
        >
          {t('ai.insight.cachedBadge')}
        </span>
      ) : null}

      {/* Несъёмный футер (AC-5.2): дисклеймер + период — в любом состоянии,
          включая отказ и стрим (§5: «дисклеймер-футер несъёмный + Период анализа»). */}
      <footer data-testid="insight-disclaimer" role="note" className="mt-2 text-sm text-muted">
        <span className="font-semibold">{disclaimerText}</span>
        {' · '}
        {t('ai.insight.periodPrefix', { period: periodText })}
      </footer>
    </div>
  );
}
