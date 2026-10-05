/**
 * TASK-073 §5.3/§10/§13/§16 + §10 072: флоу полного удаления данных (Radix
 * AlertDialog, §4). Открытие → `data/wipe` {phase:'plan'} (loading-статус — §5);
 * план: счётчик измерений, список категорий (включая копии — §5/§13 072), пункт про
 * локальные данные рендерера (rendererLocalStorage, §10 072). Предложение
 * «Сначала экспортировать» — ссылка-кнопка на экспорт 065 (report/export-json,
 * save-диалог main): успех/отказ — инлайн; отмена — тихо (§7).
 *
 * Чекбокс-гейт (§13): кнопка execute недоступна без явного подтверждения — защита
 * от Enter-спама (тест). Execute → `data/wipe` {phase:'execute'} → {restarting:true}
 * → очистка localStorage рендера (clearWipeLocalStorage, §10 072 — подключение
 * TASK-073) и блокирующий рестарт-экран (RestartOverlay, §16 role=alert). Ошибки
 * плана/execute — ИНЛАЙН в диалоге (§10), диалог остаётся жив.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  APP_INTERNAL_ERROR,
  type AppErrorDto,
  type DataWipePlan,
  type DataWipeResponse,
  type ReportExportResponse,
} from '@hl/contracts';

import { toUserMessage } from '../../../../app/errors';
import { call } from '../../../../src/lib/ipc';
import { PROFILE_ID, IpcApiError } from '../../../measurement/api/use-add-measurement';
import { clearWipeLocalStorage } from '../../../../lib/wipe-local-storage';
import { RestartOverlay } from './RestoreFlow';

/** Категории плана → ключи каталога (§22: только литералы в t() — карта явная). */
const CATEGORY_KEYS = {
  db: 'data.wipe.category.db',
  key: 'data.wipe.category.key',
  logs: 'data.wipe.category.logs',
  backups: 'data.wipe.category.backups',
} as const;

/** Basename пути (прецедент ExportButtons; для тоста экспорта, §16). */
function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

/** Props флоу удаления: управляемая модальность владельца (DataSection). */
export interface WipeFlowProps {
  /** true — флоу открыт (план запрашивается при открытии, §5). */
  readonly open: boolean;
  /** Любое закрытие (Esc/«Отмена»/после execute). */
  readonly onClose: () => void;
}

/** Инлайн-уведомление экспорта (§5: предложение «Сначала экспортировать»). */
interface ExportNotice {
  readonly kind: 'done' | 'failed';
  readonly file?: string;
}

/** Флоу «Удалить все данные» (§5.3). */
export function WipeFlow({ open, onClose }: WipeFlowProps): JSX.Element {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<DataWipePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null);

  function toErrorText(exception: unknown): string {
    const dto: AppErrorDto = exception instanceof IpcApiError ? exception.dto : APP_INTERNAL_ERROR;
    return toUserMessage(dto);
  }

  // Открытие = запрос плана (§5: plan → список → подтверждение); закрытие — сброс.
  const planMutation = useMutation({
    mutationFn: async (): Promise<DataWipeResponse> => {
      const result = await call('data/wipe', { phase: 'plan' });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      if ('plan' in data) {
        setPlan(data.plan);
        setPlanError(null);
      }
    },
    onError: (exception: unknown) => {
      setPlanError(toErrorText(exception));
    },
  });

  useEffect(() => {
    if (open) {
      setPlan(null);
      setPlanError(null);
      setAcknowledged(false);
      setRestarting(false);
      setExportNotice(null);
      planMutation.mutate();
    }
    // Мутация плана запускается только открытием флоу (план — часть открытия, §5 072).
  }, [open]);

  const exportMutation = useMutation({
    mutationFn: async (): Promise<ReportExportResponse> => {
      const result = await call('report/export-json', { profileId: PROFILE_ID });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      if ('canceled' in data) {
        return; // отмена save-диалога — тихо (§7)
      }
      setExportNotice({ kind: 'done', file: basenameOf(data.path) });
    },
    onError: () => {
      setExportNotice({ kind: 'failed' });
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (): Promise<DataWipeResponse> => {
      const result = await call('data/wipe', { phase: 'execute' });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      if ('restarting' in data) {
        // §10 072: черновики localStorage чистит РЕНДЕРЕР — после execute, до relaunch.
        clearWipeLocalStorage();
        onClose();
        setRestarting(true);
      }
    },
    onError: (exception: unknown) => {
      setPlanError(toErrorText(exception));
    },
  });

  const busy = planMutation.isPending || executeMutation.isPending;

  if (restarting) {
    return <RestartOverlay text={t('data.wipe.restarting')} />;
  }

  // Уникальные категории плана в порядке появления (план = порядок удаления §19 072).
  const categories = plan === null ? [] : [...new Set(plan.files.map((file) => file.category))];

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
        <AlertDialog.Content
          data-testid="data-wipe-dialog"
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <AlertDialog.Title data-testid="data-wipe-title" className="hl-large-title text-text">
            {t('data.wipe.dialogTitle')}
          </AlertDialog.Title>

          {plan === null && planError === null ? (
            <p data-testid="data-wipe-loading" role="status" className="mt-3 text-sm text-text">
              {t('data.wipe.planning')}
            </p>
          ) : null}

          {planError !== null ? (
            <p
              data-testid="data-wipe-error"
              role="alert"
              className="mt-3 text-sm font-medium text-text"
            >
              {planError}
            </p>
          ) : null}

          {plan !== null ? (
            <div data-testid="data-wipe-plan" className="mt-3">
              <p data-testid="data-wipe-counts" className="text-sm font-semibold text-text">
                {t('data.wipe.counts', { count: plan.counts.measurements })}
              </p>
              <AlertDialog.Description asChild>
                <p className="mt-2 text-sm text-text">{t('data.wipe.willDelete')}</p>
              </AlertDialog.Description>
              <ul
                data-testid="data-wipe-categories"
                className="mt-1 flex flex-col gap-1 text-sm text-text"
              >
                {categories.map((category) => (
                  <li key={category}>— {t(CATEGORY_KEYS[category])}</li>
                ))}
                {plan.rendererLocalStorage ? <li>— {t('data.wipe.localStorageItem')}</li> : null}
              </ul>

              <div className="mt-3">
                <button
                  type="button"
                  data-testid="data-wipe-export"
                  disabled={busy}
                  onClick={() => exportMutation.mutate()}
                  className="text-sm font-semibold text-accent underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-90"
                >
                  {t('data.wipe.exportFirst')}
                </button>
                {exportNotice !== null ? (
                  <p
                    data-testid="data-wipe-export-notice"
                    role="status"
                    className="mt-1 text-sm text-text"
                  >
                    {exportNotice.kind === 'done' && exportNotice.file !== undefined
                      ? t('data.wipe.exportDone', { basename: exportNotice.file })
                      : t('data.wipe.exportFailed')}
                  </p>
                ) : null}
              </div>

              <div className="mt-4 flex items-start gap-2">
                <input
                  id="data-wipe-confirm"
                  data-testid="data-wipe-confirm"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <label htmlFor="data-wipe-confirm" className="text-sm text-text">
                  {t('data.wipe.confirmLabel')}
                </label>
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="data-wipe-cancel"
                    className="min-h-11 rounded-xl bg-fill px-6 text-base font-semibold text-text"
                  >
                    {t('data.wipe.cancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="data-wipe-execute"
                  disabled={!acknowledged || busy}
                  aria-busy={executeMutation.isPending}
                  onClick={() => executeMutation.mutate()}
                  className="min-h-11 rounded-xl bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-90"
                >
                  {t('data.wipe.execute')}
                </button>
              </div>
            </div>
          ) : null}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
