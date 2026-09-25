/**
 * TASK-011 §5/§10: AppErrorBoundary — каркасный class-компонент границы ошибок React.
 *
 * Краш в потомке: (1) getDerivedStateFromError переключает дерево на fallback-проп —
 * пользователь видит понятный экран вместо «белого листа»/технического мусора
 * (NFR-12); (2) componentDidCatch доставляет отчёт в общий лог main через канал
 * app/log-client-error {code:'APP/RENDERER', messageKey, digest} (§7/§18) и зовёт
 * onError — дисциплина §22: каждый fallback обязан логировать digest.
 *
 * ИЕРАРХИЯ (§10): корневая граница — в App (fallback — полноэкранный, role="alert",
 * кнопка «Перезагрузить» — §13); per-feature границы появляются вместе с фичами —
 * КОНВЕНЦИЯ: оборачивать фичу <AppErrorBoundary fallback={локальный узел}>, чтобы
 * падение одной фичи не роняло журнал (арх. 06 §9); fallback — функция (info) => ReactNode.
 *
 * messageKey у неожиданного краша всегда 'errors.renderer' (каталог §17); digest —
 * хеш message+первой строки стека (errors.ts) — PHI в отчёт не попадает по
 * построению, канал дополнительно защищён redact-логгером main (TASK-010).
 */
import { Component, type ReactNode } from 'react';

import { computeDigest, logClientError, RENDERER_ERROR_CODE } from './errors';

/** Информация о краше для fallback/onError. */
export interface BoundaryErrorInfo {
  /** Ключ каталога для текста fallback — всегда errors.renderer (§17). */
  readonly messageKey: string;
  /** Дайджест краша — в общий лог для дедупликации (§7/§18). */
  readonly digest: string;
}

/** Props границы (§5): fallback-функция и опциональный onError. */
export interface AppErrorBoundaryProps {
  readonly fallback: (info: BoundaryErrorInfo) => ReactNode;
  readonly onError?: (info: BoundaryErrorInfo) => void;
  readonly children?: ReactNode;
}

interface BoundaryState {
  readonly info: BoundaryErrorInfo | null;
}

/** Ключ сообщения краша рендерера в каталоге errors.* (§17). */
const RENDERER_MESSAGE_KEY = 'errors.renderer';

function infoOf(error: Error): BoundaryErrorInfo {
  return { messageKey: RENDERER_MESSAGE_KEY, digest: computeDigest(error) };
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, BoundaryState> {
  override state: BoundaryState = { info: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { info: infoOf(error) };
  }

  override componentDidCatch(error: Error): void {
    const info = infoOf(error);
    // §9: fire-and-forget — сбой доставки глушится внутри logClientError (§13).
    logClientError({ code: RENDERER_ERROR_CODE, messageKey: info.messageKey, digest: info.digest });
    this.props.onError?.(info);
  }

  override render(): ReactNode {
    const { info } = this.state;
    return info === null ? this.props.children : this.props.fallback(info);
  }
}
