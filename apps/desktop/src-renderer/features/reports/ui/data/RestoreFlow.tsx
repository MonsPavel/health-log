/**
 * TASK-073 §5.2/§10/§13/§16: мастер-флоу восстановления — ОДИН диалог (Radix
 * AlertDialog) с шагами файл → пароль → план (§4: последовательность диалогов —
 * один мастер-флоу компонент); после execute — блокирующий рестарт-экран.
 *
 * Шаги (§10):
 *  - файл: выбор через канал `file/open-dialog` (open-диалог main — путь возникает
 *    только в main, §14); отмена — тихо, остаёмся на шаге (§7);
 *  - пароль: поле ПУСТОЕ — предзаполнения пароля копии нет (§13), ввод заново;
 *    «Продолжить» → `backup/restore` {confirmed:false} → план; ошибки шага — ИНЛАЙН
 *    в диалоге (§10: не тост — контекст важен), в т.ч. WRONG_PASSPHRASE (AC3) и
 *    DB_NEWER (текст с параметром версии);
 *  - план: предупреждения (replaces-current — всегда, older-than-current — при
 *    schemaDelta=older, §7 071), счётчики «в копии N, сейчас — M» (§13 071), дата;
 *    чекбокс «Я понимаю…» — гейт кнопки execute: БЕЗ отметки кнопка недоступна
 *    (§13 — защита от Enter-спама, тест); «Назад» до execute (§10);
 *  - execute: `backup/restore` {confirmed:true} → {restarting:true} → диалог закрыт,
 *    рестарт-экран role=alert (§16 — блокирующий, не закрываемый: приложение
 *    перезапустится отложенно, §9 071).
 *
 * RestartOverlay — общий для restore/wipe (§5: обе операции заканчиваются
 * перезапуском); текст живой (role=alert несёт implicit aria-live).
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  APP_INTERNAL_ERROR,
  type AppErrorDto,
  type BackupRestorePlan,
  type BackupRestoreResponse,
  type FileOpenDialogResponse,
} from '@hl/contracts';

import { toUserMessage } from '../../../../app/errors';
import { formatDateTime } from '../../../../lib/i18n-date';
import { tzOffsetMinOf } from '../../../../lib/period';
import { call } from '../../../../src/lib/ipc';
import { IpcApiError } from '../../../measurement/api/use-add-measurement';

/** Шаги мастера до execute (после него — рестарт-экран вне диалога, §10). */
type RestoreStep = 'file' | 'passphrase' | 'plan';

/** Фильтр open-диалога (§5: выбор файла копии .hlbackup). */
const BACKUP_FILE_FILTERS = [{ name: 'Health Log Backup', extensions: ['hlbackup'] }];

/** Props мастер-флоу: управляемая модальность владельца (DataSection). */
export interface RestoreFlowProps {
  /** true — флоу открыт (на шаге файла). */
  readonly open: boolean;
  /** Любое закрытие (Esc/«Отмена»/после execute). */
  readonly onClose: () => void;
}

/**
 * Блокирующий рестарт-экран (§10/§16): role=alert (живой текст), без действий —
 * приложение перезапустится отложенно (§9 071/072). Общий для restore/wipe.
 */
export function RestartOverlay({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      data-testid="data-restart-overlay"
      role="alert"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg p-8"
    >
      <p className="max-w-md text-center text-lg font-semibold text-text">{text}</p>
    </div>
  );
}

/** Текст инлайн-ошибки шага: DB_NEWER — с параметром версии, остальные — каталог. */
function stepErrorText(
  dto: AppErrorDto,
  translate: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (dto.messageKey === 'errors.BACKUP_DB_NEWER') {
    const version = dto.params?.['schemaVersion'];
    return translate('errors.BACKUP_DB_NEWER', {
      schemaVersion: typeof version === 'number' ? version : '',
    });
  }
  return toUserMessage(dto);
}

/** Мастер-флоу восстановления (§5.2). */
export function RestoreFlow({ open, onClose }: RestoreFlowProps): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<RestoreStep>('file');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [plan, setPlan] = useState<BackupRestorePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Сброс машины состояний при каждом открытии (§12: локальная state-машина).
  useEffect(() => {
    if (open) {
      setStep('file');
      setFilePath(null);
      setPassphrase('');
      setPlan(null);
      setError(null);
      setAcknowledged(false);
      setRestarting(false);
    }
  }, [open]);

  function toDtoError(exception: unknown): string {
    const dto = exception instanceof IpcApiError ? exception.dto : APP_INTERNAL_ERROR;
    return stepErrorText(dto, t);
  }

  const pickMutation = useMutation({
    mutationFn: async (): Promise<FileOpenDialogResponse> => {
      const result = await call('file/open-dialog', { filters: BACKUP_FILE_FILTERS });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      if ('canceled' in data) {
        return; // отмена диалога — тихо, остаёмся на шаге файла (§7)
      }
      setFilePath(data.path);
      setError(null);
      setStep('passphrase');
    },
    onError: (exception: unknown) => {
      setError(toDtoError(exception));
    },
  });

  const planMutation = useMutation({
    mutationFn: async (): Promise<BackupRestoreResponse> => {
      const result = await call('backup/restore', {
        file: filePath ?? '',
        passphrase,
        confirmed: false,
      });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      if ('plan' in data) {
        setPlan(data.plan);
        setError(null);
        setAcknowledged(false);
        setStep('plan');
      }
    },
    onError: (exception: unknown) => {
      setError(toDtoError(exception));
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (): Promise<BackupRestoreResponse> => {
      const result = await call('backup/restore', {
        file: filePath ?? '',
        passphrase,
        confirmed: true,
      });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      if ('restarting' in data) {
        onClose();
        setRestarting(true);
      }
    },
    onError: (exception: unknown) => {
      setError(toDtoError(exception));
    },
  });

  /** Назад (§10): план → пароль → файл; ошибка шага сбрасывается. */
  function goBack(): void {
    setError(null);
    setStep(step === 'plan' ? 'passphrase' : 'file');
  }

  const busy = pickMutation.isPending || planMutation.isPending || executeMutation.isPending;

  if (restarting) {
    // Рестарт-экран вне диалога: блокирующий, не закрываемый (§10/§16).
    return <RestartOverlay text={t('data.restore.restarting')} />;
  }

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
          data-testid="data-restore-dialog"
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
        >
          <AlertDialog.Title
            data-testid="data-restore-title"
            className="text-lg font-semibold text-text"
          >
            {t('data.restore.dialogTitle')}
          </AlertDialog.Title>

          {step === 'file' ? (
            <div className="mt-3">
              <AlertDialog.Description asChild>
                <p className="text-sm text-text">{t('data.restore.pickDescription')}</p>
              </AlertDialog.Description>
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="data-restore-cancel"
                    className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                  >
                    {t('data.restore.cancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="data-restore-pick"
                  disabled={busy}
                  aria-busy={pickMutation.isPending}
                  onClick={() => pickMutation.mutate()}
                  className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('data.restore.pickButton')}
                </button>
              </div>
            </div>
          ) : null}

          {step === 'passphrase' ? (
            <div className="mt-3">
              <AlertDialog.Description asChild>
                <p className="text-sm text-text">{t('data.restore.passphraseDescription')}</p>
              </AlertDialog.Description>
              <div className="mt-3 flex flex-col gap-1">
                <label htmlFor="data-restore-passphrase" className="text-sm font-medium text-text">
                  {t('data.restore.passphraseLabel')}
                </label>
                <input
                  id="data-restore-passphrase"
                  data-testid="data-restore-passphrase"
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  className="min-h-11 rounded-md border border-border bg-bg px-3 text-base text-text"
                />
              </div>
              {error !== null ? (
                <p
                  data-testid="data-restore-error"
                  role="alert"
                  className="mt-3 text-sm font-medium text-text"
                >
                  {error}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  data-testid="data-restore-back"
                  disabled={busy}
                  onClick={goBack}
                  className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                >
                  {t('data.restore.back')}
                </button>
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="data-restore-cancel"
                    className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                  >
                    {t('data.restore.cancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="data-restore-next"
                  disabled={busy}
                  aria-busy={planMutation.isPending}
                  onClick={() => planMutation.mutate()}
                  className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('data.restore.next')}
                </button>
              </div>
            </div>
          ) : null}

          {step === 'plan' && plan !== null ? (
            <div data-testid="data-restore-plan" className="mt-3">
              <p className="text-sm font-semibold text-text">{t('data.restore.planTitle')}</p>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-text">
                <li>
                  {t('data.restore.createdAt', {
                    date: formatDateTime(
                      {
                        utcMs: plan.createdAtUtc,
                        tzOffsetMin: tzOffsetMinOf(plan.createdAtUtc),
                      },
                      { preset: 'date' },
                    ),
                  })}
                </li>
                <li>{t('data.restore.schemaVersion', { version: plan.schemaVersion })}</li>
                <li>
                  {t('data.restore.counts', {
                    count: plan.counts.measurements,
                    current: plan.currentCounts.measurements,
                  })}
                </li>
              </ul>
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-accent/10 p-3 text-sm font-medium text-text">
                {plan.warnings.includes('replaces-current') ? (
                  <p data-testid="data-restore-warning-replace">
                    {t('data.restore.warningReplace')}
                  </p>
                ) : null}
                {plan.warnings.includes('older-than-current') ? (
                  <p data-testid="data-restore-warning-older">{t('data.restore.warningOlder')}</p>
                ) : null}
              </div>

              <div className="mt-4 flex items-start gap-2">
                <input
                  id="data-restore-confirm"
                  data-testid="data-restore-confirm"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <label htmlFor="data-restore-confirm" className="text-sm text-text">
                  {t('data.restore.confirmLabel')}
                </label>
              </div>

              {error !== null ? (
                <p
                  data-testid="data-restore-error"
                  role="alert"
                  className="mt-3 text-sm font-medium text-text"
                >
                  {error}
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  data-testid="data-restore-back"
                  disabled={busy}
                  onClick={goBack}
                  className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                >
                  {t('data.restore.back')}
                </button>
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="data-restore-cancel"
                    className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                  >
                    {t('data.restore.cancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="data-restore-execute"
                  disabled={!acknowledged || busy}
                  aria-busy={executeMutation.isPending}
                  onClick={() => executeMutation.mutate()}
                  className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('data.restore.execute')}
                </button>
              </div>
            </div>
          ) : null}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
