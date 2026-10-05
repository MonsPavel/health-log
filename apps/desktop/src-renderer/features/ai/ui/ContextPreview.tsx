/**
 * TASK-088 §5/§10: блок «Что передаётся ИИ» — точный текст проекции (не абстрактное
 * «ваши данные», §4): моноширинный pre-wrap блок, текст КАК ЕСТЬ (без md-рендера —
 * решение §5), по умолчанию свёрнут до 10 строк с «Показать всё»; короткий текст —
 * без переключателя (сворачивать нечего). Компонент презентационный: данные — проп.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Лимит свёртки (§5: «свёрнут до 10 строк»). */
const COLLAPSED_LINES = 10;

/** Props превью (§5): готовый текст проекции из канала ai/context/preview. */
export interface ContextPreviewProps {
  /** Полный текст контекста (PHI — показывается только владельцу, §14 083). */
  readonly text: string;
}

/** Превью передаваемых данных (§2): моноширинный блок + свёртка. */
export function ContextPreview({ text }: ContextPreviewProps): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const lines = text.split('\n');
  const collapsible = lines.length > COLLAPSED_LINES;
  const visible = collapsible && !expanded ? lines.slice(0, COLLAPSED_LINES).join('\n') : text;

  return (
    <div>
      <pre
        data-testid="ai-context-preview"
        className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-sm text-text"
      >
        {visible}
      </pre>
      {collapsible ? (
        <button
          type="button"
          data-testid="ai-context-preview-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 text-sm font-semibold text-accent underline underline-offset-2"
        >
          {expanded ? t('ai.insight.preview.collapse') : t('ai.insight.preview.showAll')}
        </button>
      ) : null}
    </div>
  );
}
