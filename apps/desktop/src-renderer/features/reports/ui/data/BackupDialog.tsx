/**
 * TASK-073 §5/§13/§14/§16/§17: диалог создания копии (Radix AlertDialog — §4:
 * опасные действия через AlertDialog, Esc/отмена — безопасный дефолт).
 *
 * Поля пароля — дважды (подтверждение), type=password (§14); проверка совпадения —
 * клиентская, ДО канала (§19-тест); политика ≥8 — ПРЕДУПРЕЖДЕНИЕ, не блокировка
 * (§13 070: main не проверяет длину); предупреждение «Забыли пароль — данные копии
 * невосстановимы» — обязательный элемент диалога (§14, тест текста).
 *
 * Канал `backup/create` {mode:'ask', passphrase} (070): успех → диалог закрыт +
 * тост с именем файла (ответ канала — basename, §14; role=status — §16-прецедент
 * ExportButtons, автоскрытие 6 с); BACKUP/CANCELED (отказ диалога сохранения main) —
 * тихое закрытие, не ошибка (§7); прочие ошибки — ИНЛАЙН в диалоге (§10: контекст
 * важен), диалог открыт.
 *
 * Безопасность (§14): пароль живёт только в состоянии формы и уходит только в канал;
 * не логируется и не сохраняется.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_INTERNAL_ERROR, type BackupCreateResponse } from '@hl/contracts';

import { toUserMessage } from '../../../../app/errors';
import { call } from '../../../../src/lib/ipc';
import { IpcApiError } from '../../../measurement/api/use-add-measurement';

/** Автоскрытие тоста, мс (§10-прецедент ExportButtons). */
const NOTICE_MS = 6000;

/** Props диалога: управляемая модальность владельца (DataSection). */
export interface BackupDialogProps {
  /** true — диалог открыт. */
  readonly open: boolean;
  /** Любое закрытие (Esc/«Отмена»/после успеха). */
  readonly onClose: () => void;
}

/** Локальный тост успеха (§10): basename файла копии. */
interface BackupNotice {
  readonly file: string;
}

/** Диалог «Создать копию» (§5.1). */
export function BackupDialog({ open, onClose }: BackupDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [passphraseRepeat, setPassphraseRepeat] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<BackupNotice | null>(null);

  const createMutation = useMutation({
    mutationFn: async (pass: string): Promise<BackupCreateResponse> => {
      const result = await call('backup/create', { mode: 'ask', passphrase: pass });
      if (!result.ok) {
        throw new IpcApiError(result.error);
      }
      return result.data;
    },
    onSuccess: (data) => {
      setNotice({ file: data.file });
      resetAndClose();
    },
    onError: (error: unknown) => {
      const dto = error instanceof IpcApiError ? error.dto : APP_INTERNAL_ERROR;
      if (dto.code === 'BACKUP/CANCELED') {
        // Отказ диалога сохранения main — ожидаемый исход, тихо (§7).
        resetAndClose();
        return;
      }
      setFormError(toUserMessage(dto));
    },
  });

  // Автоскрытие тоста (§16: регион role=status, прецедент notice TASK-038).
  useEffect(() => {
    if (notice === null) {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Сброс формы и закрытие (пароль из состояния уходит — §14). */
  function resetAndClose(): void {
    setPassphrase('');
    setPassphraseRepeat('');
    setFormError(null);
    onClose();
  }

  /** Сабмит: клиентские проверки → канал. Ошибки — инлайн (§10). */
  function handleSubmit(): void {
    setFormError(null);
    if (passphrase.trim().length === 0) {
      setFormError(t('data.backup.emptyError'));
      return;
    }
    if (passphrase !== passphraseRepeat) {
      setFormError(t('data.backup.mismatchError'));
      return;
    }
    createMutation.mutate(passphrase);
  }

  // Политика ≥8 — предупреждение рядом с формой, не блокировка (§13 070).
  const policyWarningVisible = passphrase.length > 0 && passphrase.length < 8;

  return (
    <>
      <AlertDialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            resetAndClose();
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
          <AlertDialog.Content
            data-testid="data-backup-dialog"
            className="fixed left-1/2 top-1/2 w-[min(26rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-bg p-6 shadow-lg"
          >
            <AlertDialog.Title
              data-testid="data-backup-title"
              className="text-lg font-semibold text-text"
            >
              {t('data.backup.dialogTitle')}
            </AlertDialog.Title>

            <AlertDialog.Description asChild>
              <p className="mt-2 text-sm text-text">{t('data.backup.description')}</p>
            </AlertDialog.Description>

            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="data-backup-passphrase" className="text-sm font-medium text-text">
                  {t('data.backup.passphraseLabel')}
                </label>
                <input
                  id="data-backup-passphrase"
                  data-testid="data-backup-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  className="min-h-11 rounded-md border border-border bg-bg px-3 text-base text-text"
                />
                {policyWarningVisible ? (
                  <p
                    data-testid="data-backup-policy-warning"
                    className="text-sm text-accent"
                    role="note"
                  >
                    {t('data.backup.policyWarning')}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="data-backup-passphrase-repeat"
                  className="text-sm font-medium text-text"
                >
                  {t('data.backup.passphraseRepeatLabel')}
                </label>
                <input
                  id="data-backup-passphrase-repeat"
                  data-testid="data-backup-passphrase-repeat"
                  type="password"
                  autoComplete="new-password"
                  value={passphraseRepeat}
                  onChange={(event) => setPassphraseRepeat(event.target.value)}
                  className="min-h-11 rounded-md border border-border bg-bg px-3 text-base text-text"
                />
              </div>

              {/* Обязательное предупреждение (§14: тест текста; контраст AA — text-text). */}
              <p
                data-testid="data-backup-forgot-warning"
                className="rounded-md border border-border bg-accent/10 p-3 text-sm font-medium text-text"
                role="note"
              >
                {t('data.backup.forgotWarning')}
              </p>

              {formError !== null ? (
                <p
                  data-testid="data-backup-error"
                  role="alert"
                  className="text-sm font-medium text-text"
                >
                  {formError}
                </p>
              ) : null}
            </div>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  data-testid="data-backup-cancel"
                  className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                >
                  {t('data.backup.cancel')}
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                data-testid="data-backup-submit"
                disabled={createMutation.isPending}
                aria-busy={createMutation.isPending}
                onClick={handleSubmit}
                className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createMutation.isPending ? <Spinner /> : null}
                {t('data.backup.submit')}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Тост успеха — вне диалога (диалог после успеха закрыт); basename — полный текст (§16). */}
      {notice !== null ? (
        <div role="status" data-testid="data-backup-toast" className="mt-3 text-sm text-accent">
          {t('data.backup.done', { basename: notice.file })}
        </div>
      ) : null}
    </>
  );
}

/** Спиннер кнопки (§5: loading; декоративный, §16 — прецедент ExportButtons). */
function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
