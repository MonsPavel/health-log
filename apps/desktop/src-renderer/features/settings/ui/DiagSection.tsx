/**
 * TASK-103 §5/§10/§16/§17: секция «Диагностика» экрана настроек. Поток (§2):
 * «Собрать пакет» → канал diag/preview → предпросмотр (семантичная таблица
 * файлов с размерами, превью первых строк, счётчик событий за 90 дней) →
 * «Сохранить…» → канал diag/save (путь — save-диалог main, §14). Предпросмотр
 * ОБЯЗАТЕЛЕН до сохранения (§14 AC): кнопка «Сохранить…» активна только когда
 * содержимое собрано и показано; сразу видимая (§16 — без скролла).
 *
 * GOLDEN (§10/§20-6): предупреждение «в пакет не входят ваши измерения и
 * заметки» — видимо всегда (до и после сбора — пользователь знает заранее,
 * что в пакете). Гарантия-строка — выше кнопки (честность BG-2, прецедент
 * обещания «Приватности»).
 *
 * РАЗМЕРЫ (§17): Intl.NumberFormat('ru-RU') — Б/КБ/МБ.
 *
 * ОШИБКИ (§10): отказ канала — role="alert" текстом каталога; отмена диалога
 * ({canceled: true}) — тихий исход, не ошибка (§7 065).
 */
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import type { DiagContent } from '@hl/contracts';

import { useDiagCollect, useDiagSave } from '../api/use-diag';

/** Размер в человекочитаемой форме (§17: Intl, ru-формат). */
export function formatDiagSize(bytes: number): string {
  const format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  if (bytes < 1024) {
    return `${format.format(bytes)} Б`;
  }
  if (bytes < 1024 * 1024) {
    return `${format.format(bytes / 1024)} КБ`;
  }
  return `${format.format(bytes / (1024 * 1024))} МБ`;
}

/** Kinds агрегатов в детерминированном порядке (отображение, не данные). */
function sortedKinds(eventsByKind: Record<string, number>): Array<[string, number]> {
  return Object.entries(eventsByKind).sort(([a], [b]) => a.localeCompare(b));
}

/** Секция «Диагностика» (§5). */
export function DiagSection(): JSX.Element {
  const { t } = useTranslation();
  const collect = useDiagCollect();
  const save = useDiagSave();
  const content: DiagContent | undefined = collect.data;
  const savedPath = save.data && 'path' in save.data ? save.data.path : undefined;

  return (
    <section aria-labelledby="diag-title" data-testid="diag-section" className="mt-6">
      <h2 id="diag-title" className="mb-2 text-base font-medium">
        {t('diag.title')}
      </h2>
      {/* §10: гарантия-строка и golden-предупреждение — видны всегда (до сбора). */}
      <p
        data-testid="diag-guarantee"
        role="note"
        className="rounded-md border border-border p-3 text-sm text-text"
      >
        {t('diag.guarantee')}
      </p>
      <p data-testid="diag-warning" className="mt-2 text-sm text-accent">
        {t('diag.warning')}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          data-testid="diag-collect"
          disabled={collect.isPending}
          aria-busy={collect.isPending}
          onClick={() => collect.mutate()}
          className="min-h-11 rounded-md border border-border bg-bg px-4 text-base font-semibold text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {collect.isPending ? t('diag.collecting') : t('diag.collect')}
        </button>
        {/* §16: «Сохранить…» — сразу видимая рядом со сбором; активна только после
            предпросмотра (§14: предпросмотр обязателен — нельзя сохранить невиденное). */}
        <button
          type="button"
          data-testid="diag-save"
          disabled={content === undefined || save.isPending}
          aria-busy={save.isPending}
          onClick={() => save.mutate()}
          className="min-h-11 rounded-md bg-accent px-4 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-80"
        >
          {save.isPending ? t('diag.saving') : t('diag.save')}
        </button>
      </div>

      {collect.isError ? (
        <p role="alert" className="mt-2 text-sm text-status-fail">
          {t('diag.collectError')}
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="mt-2 text-sm text-status-fail">
          {t('diag.saveError')}
        </p>
      ) : null}
      {/* {path} — статус; {canceled: true} — тихо (§7 065: отмена — не ошибка). */}
      {savedPath !== undefined ? (
        <p role="status" data-testid="diag-saved" className="mt-2 text-sm text-accent">
          {t('diag.saved')}
        </p>
      ) : null}

      {/* Предпросмотр (§5/§10): таблица семантичная (§16), дерево файлов с размерами. */}
      {content !== undefined ? (
        <div data-testid="diag-preview" className="mt-3 flex flex-col gap-3">
          <h3 className="text-sm font-medium">{t('diag.preview')}</h3>
          <table data-testid="diag-files" className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('diag.filesColumn')}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t('diag.sizeColumn')}
                </th>
              </tr>
            </thead>
            <tbody>
              {content.files.map((file) => (
                <Fragment key={file.name}>
                  <tr data-testid="diag-file-row">
                    <td className="py-1 pr-3 align-top">
                      <span className="font-medium">{file.name}</span>
                      {file.preview !== undefined ? (
                        <pre
                          data-testid="diag-file-preview"
                          className="mt-1 whitespace-pre-wrap break-all rounded border border-border p-2 text-xs text-accent"
                        >
                          {file.preview}
                        </pre>
                      ) : (
                        <span className="sr-only">{t('diag.noPreview')}</span>
                      )}
                    </td>
                    <td data-testid="diag-file-size" className="py-1 align-top text-accent">
                      {formatDiagSize(file.sizeBytes)}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>

          {/* Счётчик записей (§5: агрегаты app_event за 90 дней — метаданные). */}
          <div data-testid="diag-totals" className="rounded-md border border-border p-3">
            <p className="text-sm font-medium">{t('diag.totalsTitle')}</p>
            {sortedKinds(content.totals.eventsByKind).length === 0 ? (
              <p className="mt-1 text-sm text-accent">{t('diag.totalsEmpty')}</p>
            ) : (
              <dl className="mt-1 flex flex-col gap-1">
                {sortedKinds(content.totals.eventsByKind).map(([kind, count]) => (
                  <div key={kind} className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-accent">{kind}</dt>
                    <dd className="text-sm font-medium text-text">{count}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
