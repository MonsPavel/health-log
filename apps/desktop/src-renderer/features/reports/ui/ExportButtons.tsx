/**
 * TASK-065 §5/§10/§12/§16/§17: кнопки экспорта CSV/JSON на экране «Отчёты»
 * (маршрут /reports — дом экспорта+PDF+копий, §5 РЕШЕНИЕ). US-27: пользователь
 * физически получает файл — main открывает save-диалог (§14: renderer присылает
 * только тип экспорта), ответ канала — {path} | {canceled: true}.
 *
 * СОСТОЯНИЕ (§12): useMutation на каждую кнопку поверх call() канала; invalidate
 * не нужен (данных журнал не меняет). §10: одновременно один экспорт — на время
 * операции ОБЕ кнопки недоступны; на активной aria-busy (§16). Тост успеха —
 * локальный статус-регион role="status" (§16): текст — basename (полный носитель),
 * полный путь — title-атрибут (не единственный носитель, §16). Отмена — тихо (§7);
 * ошибка — failed+hint по каталогу export.* (§10/§17); автоскрытие 6 с (§10-прецедент).
 *
 * profileId — seed-профиль MVP (PROFILE_ID, прецедент DashboardScreen: единственный
 * профиль до фичи выбора профилей).
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_INTERNAL_ERROR, type ReportExportResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError, PROFILE_ID } from '../../measurement/api/use-add-measurement';

/** Автоскрытие тоста, мс (§10 — тот же интервал, что у системного тоста). */
const NOTICE_MS = 6000;

/** Вызов канала экспорта: разворот конверта; failure → IpcApiError (§11). */
async function exportFile(
  channel: 'report/export-csv' | 'report/export-json',
): Promise<ReportExportResponse> {
  const result = await call(channel, { profileId: PROFILE_ID });
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Basename пути (разделители обеих платформ) — для тоста (§10). */
function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

/** Локальный тост: успех (с путём) или ошибка; отмена — состояние не меняет (§7). */
interface ExportNotice {
  readonly kind: 'success' | 'error';
  readonly path?: string;
}

const BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-base ' +
  'font-medium hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50';

/** Кнопки экспорта CSV/JSON (§5): loading, тост успеха/ошибки, отмена тихо. */
export function ExportButtons(): JSX.Element {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<ExportNotice | null>(null);

  // §12: useMutation per-кнопка; ошибки — значением dto; отмена — тихо (§7/AC2).
  const csvMutation = useMutation({
    mutationFn: () => exportFile('report/export-csv'),
    onSuccess: (data) => {
      if ('canceled' in data) {
        return;
      }
      setNotice({ kind: 'success', path: data.path });
    },
    onError: (error) => {
      const dto = error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR;
      if (dto.code === 'EXPORT/FAILED') {
        setNotice({ kind: 'error' });
      }
    },
  });
  const jsonMutation = useMutation({
    mutationFn: () => exportFile('report/export-json'),
    onSuccess: (data) => {
      if ('canceled' in data) {
        return;
      }
      setNotice({ kind: 'success', path: data.path });
    },
    onError: (error) => {
      const dto = error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR;
      if (dto.code === 'EXPORT/FAILED') {
        setNotice({ kind: 'error' });
      }
    },
  });

  // §10: одновременно один экспорт — обе кнопки недоступны на время любой операции.
  const isBusy = csvMutation.isPending || jsonMutation.isPending;

  // Автоскрытие тоста (§16: регион role=status, прецедент notice TASK-038).
  useEffect(() => {
    if (notice === null) {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className="mb-6 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={isBusy}
          aria-busy={csvMutation.isPending}
          onClick={() => void csvMutation.mutate()}
          className={BUTTON_CLASS}
        >
          {csvMutation.isPending ? <Spinner /> : null}
          {t('export.csv')}
        </button>
        <button
          type="button"
          disabled={isBusy}
          aria-busy={jsonMutation.isPending}
          onClick={() => void jsonMutation.mutate()}
          className={BUTTON_CLASS}
        >
          {jsonMutation.isPending ? <Spinner /> : null}
          {t('export.json')}
        </button>
      </div>
      {/* §16: роль status (скринридер); basename — полный текст, путь — title. */}
      {notice !== null ? (
        <div role="status" className="mt-3 text-sm text-accent" data-testid="export-notice">
          {notice.kind === 'success' && notice.path !== undefined ? (
            <span title={notice.path}>
              {t('export.done', { basename: basenameOf(notice.path) })}
            </span>
          ) : (
            <span>
              {t('export.failed')} {t('export.hint')}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Спиннер кнопки (§5: «состояние loading (спиннер на кнопке)»); декоративный (§16). */
function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
