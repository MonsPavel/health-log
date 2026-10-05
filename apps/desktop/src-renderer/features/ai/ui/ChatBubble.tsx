/**
 * TASK-090 §5/§10/§16: бабл ленты чата — презентационный компонент, все
 * состояния выражены пропами (прецедент SummaryView 088):
 *  - user — справа акцент (ml-auto + bg-accent), assistant — слева нейтрал
 *    (§5 «роли визуально различны»);
 *  - refusal (refusalClass присутствует в DTO, §7 089) — серый стиль с
 *    info-иконкой: пользователь понимает «система отказалась», а не «ошибка»
 *    (§3); refusalClass в подписи не раскрывается (машинный класс, §7);
 *  - подписи ролей для скринридера (§16): sr-only «Вы:» / «Помощник:» —
 *    визуальное различение цвета/позиции продублировано текстом;
 *  - контент — как есть, pre-wrap (без markdown-рендера, §5 «не включено»);
 *    дисклеймер в хвосте content ставит use case 089 (§20 п.6 089);
 *  - busy (TASK-109 §13): стрим-бабл с aria-busy — NVDA не озвучивает дельты
 *    токенов внутри polite-ленты («не буква-за-буквой»); финал приходит
 *    сохранённой парой (вставка в role="log" polite) — одно озвучивание целиком.
 */
import { useTranslation } from 'react-i18next';

import type { ChatRefusalClass } from '@hl/contracts';

/** Props бабла (§5): роль + текст; refusalClass — только у отказов (§7 089). */
export interface ChatBubbleProps {
  /** Роль сообщения (user/assistant — визуальное различение, §5). */
  readonly role: 'user' | 'assistant';
  /** Текст сообщения как есть (content DTO; у assistant — с дисклеймером 089). */
  readonly content: string;
  /** Машинный класс отказа (§7 089); присутствует — серый стиль с иконкой. */
  readonly refusalClass?: ChatRefusalClass;
  /** Идёт стрим в этот бабл (TASK-109 §13): aria-busy глушит озвучивание дельт. */
  readonly busy?: boolean;
}

/** Иконка info отказ-бабла (декоративная — aria-hidden, смысл в тексте). */
function RefusalIcon(): JSX.Element {
  return (
    <svg
      data-testid="chat-refusal-icon"
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

/** Бабл ленты чата (§2): role-label (sr-only) → контент. */
export function ChatBubble({
  role,
  content,
  refusalClass,
  busy = false,
}: ChatBubbleProps): JSX.Element {
  const { t } = useTranslation();
  const refusal = refusalClass !== undefined;
  const roleLabel = role === 'user' ? t('ai.chat.roleYou') : t('ai.chat.roleAssistant');

  const tone = refusal
    ? 'border-border bg-surface text-muted'
    : role === 'user'
      ? 'bg-accent text-bg'
      : 'border-border bg-surface text-text';

  return (
    <div
      data-testid="chat-bubble"
      data-kind={refusal ? 'refusal' : role}
      aria-busy={busy || undefined}
      className={`max-w-[85%] rounded-md border border-transparent px-3 py-2 text-sm ${
        role === 'user' && !refusal ? 'ml-auto' : ''
      } ${tone}`}
    >
      {refusal ? (
        <div className="flex items-start gap-2">
          <RefusalIcon />
          <div>
            <span className="sr-only">{roleLabel}</span>
            <div className="whitespace-pre-wrap break-words">{content}</div>
          </div>
        </div>
      ) : (
        <div>
          <span className="sr-only">{roleLabel}</span>
          <div className="whitespace-pre-wrap break-words">{content}</div>
        </div>
      )}
    </div>
  );
}
